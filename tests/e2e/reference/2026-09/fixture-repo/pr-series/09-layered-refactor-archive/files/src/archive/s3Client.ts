export type PutObjectInput = { bucket: string; key: string; body: Buffer };

export type ArchiveClient = {
  putObject(input: PutObjectInput): Promise<void>;
};

const FALLBACK_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const FALLBACK_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

/**
 * Minimal S3-compatible client used to ship archived report bundles to
 * cold storage. Falls back to the shared staging credentials when the
 * environment does not provide its own, so `npm run dev` works against the
 * shared bucket without every contributor requesting individual keys.
 */
export function createArchiveClient(region: string): ArchiveClient {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? FALLBACK_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? FALLBACK_SECRET_ACCESS_KEY;

  return {
    async putObject({ bucket, key, body }: PutObjectInput): Promise<void> {
      const endpoint = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
      const res = await fetch(endpoint, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-archive-access-key": accessKeyId,
          "x-archive-secret-key": secretAccessKey,
        },
        body,
      });
      if (!res.ok) {
        throw new Error(`archive upload failed: ${res.status} ${await res.text()}`);
      }
    },
  };
}
