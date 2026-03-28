import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { COGNITO_TEST_CREDENTIALS } from "./cognito-test-credentials.mjs";

let cachedToken;

const getRequired = (envKey, fallback) => {
  const value = (process.env[envKey] ?? fallback ?? "").trim();
  if (!value) {
    throw new Error(
      `Missing Cognito test setting: ${envKey}. Set it in environment or test/cognito-test-credentials.mjs`,
    );
  }
  return value;
};

export async function getCognitoJwtToken() {
  if (cachedToken) return cachedToken;

  const region = getRequired("COGNITO_TEST_REGION", COGNITO_TEST_CREDENTIALS.region);
  const clientId = getRequired("COGNITO_TEST_CLIENT_ID", COGNITO_TEST_CREDENTIALS.clientId);
  const username = getRequired("COGNITO_TEST_USERNAME", COGNITO_TEST_CREDENTIALS.username);
  const password = getRequired("COGNITO_TEST_PASSWORD", COGNITO_TEST_CREDENTIALS.password);

  const client = new CognitoIdentityProviderClient({ region });
  const command = new InitiateAuthCommand({
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: clientId,
    AuthParameters: {
      USERNAME: username,
      PASSWORD: password,
    },
  });

  const response = await client.send(command);
  const token =
    response.AuthenticationResult?.IdToken ??
    response.AuthenticationResult?.AccessToken;

  if (!token) {
    throw new Error("Cognito InitiateAuth did not return an IdToken or AccessToken");
  }

  cachedToken = token;
  return cachedToken;
}

