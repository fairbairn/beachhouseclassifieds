declare module "json-hash" {
  export type DigestOptions = {
    algorithm?: string;
    inputEncoding?: BufferEncoding;
    outputEncoding?: BufferEncoding | "hex" | "base64" | "latin1";
    crypto?: {
      createHash(algorithm: string): {
        update(data: string, inputEncoding?: BufferEncoding): unknown;
        digest(encoding?: BufferEncoding | "hex" | "base64" | "latin1"): string;
      };
    };
    sets?: boolean;
  };

  export function digest(value: unknown, options?: DigestOptions): string;
}
