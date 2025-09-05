import { Client } from "@microsoft/microsoft-graph-client";
import { ClientSecretCredential, AzureAuthorityHosts } from "@azure/identity";

class CustomAuthProvider {
  constructor(
    private credential: ClientSecretCredential,
    private scopes: string[]
  ) {}

  async getAccessToken(): Promise<string> {
    const token = await this.credential.getToken(this.scopes);
    return token?.token ?? "";
  }
}


export type MsftCloud = "Public" | "AzureUSGovernment";


export function makeGraphClient(params: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    cloud?: MsftCloud;
}) {
    const cloud = (params.cloud ?? (process.env.MSFT_CLOUD as MsftCloud) ?? "Public") as MsftCloud;


    const authorityHost = cloud === "AzureUSGovernment"
        ? AzureAuthorityHosts.AzureGovernment
        : AzureAuthorityHosts.AzurePublicCloud;


    const credential = new ClientSecretCredential(
        params.tenantId,
        params.clientId,
        params.clientSecret,
        { authorityHost }
    );


    const graphResource = cloud === "AzureUSGovernment"
        ? "https://graph.microsoft.us"
        : "https://graph.microsoft.com";


    const authProvider = new CustomAuthProvider(credential, [
        graphResource + "/.default",
    ]);


    const baseUrl = graphResource + "/v1.0";


    return Client.initWithMiddleware({
        authProvider,
        baseUrl,
    });
}
