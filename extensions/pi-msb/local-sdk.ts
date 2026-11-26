export async function loadLocalSdk() {
  const sdk = await import("microsandbox");
  const Sandbox = sdk.Sandbox.local();
  return { Sandbox, Image: sdk.Image, NetworkPolicy: sdk.NetworkPolicy, defaultBackendKind: () => Sandbox.context.kind };
}
