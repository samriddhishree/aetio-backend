import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";

let cachedAssumeRoleProvider: AwsCredentialIdentityProvider | undefined;

export async function getAwsAssumeRoleProvider(): Promise<AwsCredentialIdentityProvider | undefined> {
  console.log(cachedAssumeRoleProvider ? cachedAssumeRoleProvider: "Creating new AWS credentials provider");
  const roleArn = "arn:aws:iam::348665872628:role/aetio-admin";
  if (!roleArn) return undefined;

  if (!cachedAssumeRoleProvider) {
    const roleSessionName =
      process.env.AWS_ASSUME_ROLE_SESSION_NAME?.trim() ??
      `aetio-backend-${process.pid}`;
    const externalId = process.env.AWS_ASSUME_ROLE_EXTERNAL_ID?.trim();
    console.log("Creating new AWS credentials provider with", { roleArn, roleSessionName, externalId: !!externalId });
    try {
      cachedAssumeRoleProvider = fromTemporaryCredentials({
        params: {
          RoleArn: roleArn,
          RoleSessionName: roleSessionName,
          ...(externalId ? { ExternalId: externalId } : {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to create AWS temporary credentials provider", { message, roleArn });
      return undefined;
    }
    console.log(cachedAssumeRoleProvider);
  }

  return cachedAssumeRoleProvider;
}

export function getCachedAwsAssumeRoleProvider(): AwsCredentialIdentityProvider | undefined {
  console.log(cachedAssumeRoleProvider);
  return cachedAssumeRoleProvider;
}
