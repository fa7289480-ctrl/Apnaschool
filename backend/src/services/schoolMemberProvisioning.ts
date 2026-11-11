import { TokenType, type Prisma, type Role } from '@prisma/client';
import type { Request } from 'express';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { conflict } from '../middleware/errorHandler.js';
import { publicUser } from '../middleware/auth.js';
import { logger } from '../middleware/requestLogger.js';
import { emailEnabled, sendVerificationEmail } from './email.js';
import { generateTempPassword, hashPassword } from './password.js';
import { generateToken } from './token.js';
import { withAcademicMutation } from './academicMutation.js';

type ProvisionableRole = Extract<Role, 'TEACHER' | 'PARENT' | 'STUDENT'>;
type Profile = { id: string };

interface ProvisionSchoolMemberInput<TProfile extends Profile> {
  req: Request;
  schoolId: string;
  role: ProvisionableRole;
  firstName: string;
  lastName: string;
  email?: string;
  createProfile: (tx: Prisma.TransactionClient, userId: string | null) => Promise<TProfile>;
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}

export async function provisionSchoolMember<TProfile extends Profile>(
  input: ProvisionSchoolMemberInput<TProfile>,
) {
  const tempPassword = input.email ? generateTempPassword() : null;
  const passwordHash = tempPassword ? await hashPassword(tempPassword) : null;
  const accountCreated = Boolean(input.email);

  const created = await withAcademicMutation(
    input.req,
    input.schoolId,
    {
      userId: input.req.user!.id,
      action: `${input.role}_${accountCreated ? 'ACCOUNT_AND_PROFILE' : 'PROFILE'}_CREATED`,
      entity: input.role === 'TEACHER' ? 'Teacher' : input.role === 'PARENT' ? 'Parent' : 'Student',
      metadata: { role: input.role, accountCreated },
    },
    async (tx) => {
      let user: Awaited<ReturnType<typeof tx.user.create>> | null = null;
      let verificationToken: { token: string; id: string } | null = null;
      if (input.email && passwordHash) {
        const duplicate = await tx.user.findUnique({
          where: { email: input.email },
          select: { id: true },
        });
        if (duplicate) throw conflict('An account with this email already exists');

        try {
          const { nextUserPublicCode, suggestUsername } = await import('./publicCodes.js');
          const publicCode = await nextUserPublicCode(input.role, tx);
          const username = suggestUsername(input.firstName, publicCode);
          user = await tx.user.create({
            data: {
              email: input.email,
              passwordHash,
              firstName: input.firstName,
              lastName: input.lastName,
              role: input.role,
              schoolId: input.schoolId,
              publicCode,
              username,
              mustChangePassword: true,
              isActive: true,
            },
          });
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            throw conflict('An account with this email already exists');
          }
          throw error;
        }

        const generatedToken = generateToken(env.SESSION_SECRET);
        const tokenRecord = await tx.token.create({
          data: {
            userId: user.id,
            type: TokenType.EMAIL_VERIFICATION,
            tokenHash: generatedToken.tokenHash,
            expiresAt: new Date(Date.now() + env.TOKEN_TTL_MINUTES * 60 * 1000),
          },
        });
        verificationToken = { token: generatedToken.token, id: tokenRecord.id };
      }

      const profile = await input.createProfile(tx, user?.id ?? null);
      return {
        result: { profile, user: user ? publicUser(user) : null, verificationToken },
        entityId: profile.id,
      };
    },
  );

  const { profile, user, verificationToken } = created;
  let verificationEmailStatus: 'sent' | 'captured' | 'failed' | null = null;
  if (verificationToken && input.email) {
    try {
      const verificationUrl = `${env.APP_BASE_URL}/verify-email.html?token=${encodeURIComponent(verificationToken.token)}`;
      await sendVerificationEmail(input.email, { name: input.firstName, verificationUrl });
      verificationEmailStatus = emailEnabled ? 'sent' : 'captured';
    } catch (error) {
      verificationEmailStatus = 'failed';
      try {
        await prisma.token.deleteMany({ where: { id: verificationToken.id } });
      } catch (cleanupError) {
        logger.error(
          { action: 'provisioned_verification_token_cleanup_failed', errorName: cleanupError instanceof Error ? cleanupError.name : 'UnknownError' },
          'provisioned verification token cleanup failed',
        );
      }
      logger.error(
        { action: 'provisioned_verification_email_delivery_failed', role: input.role, errorName: error instanceof Error ? error.name : 'UnknownError' },
        'provisioned account verification email could not be delivered',
      );
    }
  }

  return {
    profile,
    user,
    ...(tempPassword ? { tempPassword } : {}),
    mustChangePassword: accountCreated,
    verificationEmailStatus,
  };
}
