// Credential-class environment names are NEVER forwarded to plugin processes,
// probe/run payloads, or native CLIs — even if a manifest declares them in
// required_env. Covers the Jev key, router tokens, and provider credentials.
const ENV_DENY =
  /(_|^)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|BEARER|SESSION_?KEY)(_|$)|^(JEV_|TYPESAFE_|ROUTER_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_|AWS_|AZURE_|XAI_|MISTRAL_|COHERE_|DEEPSEEK_)/i;

export function envNameDenied(name: string): boolean {
  return ENV_DENY.test(name);
}
