import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import {
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";

let cachedAssumeRoleProvider: AwsCredentialIdentityProvider | undefined;

export function getAwsAssumeRoleProvider(): AwsCredentialIdentityProvider | undefined {
  const roleArn = "arn:aws:iam::348665872628:role/aetio-admin";
  if (!roleArn) return undefined;

  if (!cachedAssumeRoleProvider) {
    const roleSessionName =
      process.env.AWS_ASSUME_ROLE_SESSION_NAME?.trim() ??
      `aetio-backend-${process.pid}`;
    const externalId = process.env.AWS_ASSUME_ROLE_EXTERNAL_ID?.trim();

    cachedAssumeRoleProvider = fromTemporaryCredentials({
      params: {
        RoleArn: roleArn,
        RoleSessionName: roleSessionName,
        ...(externalId ? { ExternalId: externalId } : {}),
      },
    });
  }

  return cachedAssumeRoleProvider;
}
