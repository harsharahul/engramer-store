declare module "aws4" {
  export interface SignRequest {
    host?: string;
    method?: string;
    path?: string;
    service?: string;
    region?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  }
  export interface Credentials {
    accessKeyId: string;
    secretAccessKey: string;
  }
  export function sign(request: SignRequest, credentials: Credentials): SignRequest;
  const aws4: { sign: typeof sign };
  export default aws4;
}
