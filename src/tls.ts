// attn's TLS certificate, for https://attn.localhost:<port>.
//
// The certificate is self-signed, valid only for attn.localhost, and cannot
// sign other certificates (CA:FALSE). Its private key never leaves tls.pem in
// the owner-only state directory. `attn setup https` asks macOS to trust it.
//
// TLS is what makes the dashboard's fixed address safe on a Mac shared with
// other accounts. While attn is stopped, another account can listen on its
// port, but it cannot present this certificate, so the browser stops at a
// certificate warning. Chrome refuses a service worker from such a page even
// if the user clicks through, and no live session token is within its reach
// (sessions.ts).
import { spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DASHBOARD_HOSTNAME = "attn.localhost";
// Apple rejects TLS server certificates valid for more than 825 days, even
// ones the user trusts.
const VALIDITY_DAYS = 800;
const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;
const OPENSSL = "/usr/bin/openssl";

const OPENSSL_CONFIG = `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${DASHBOARD_HOSTNAME}
[ext]
subjectAltName = DNS:${DASHBOARD_HOSTNAME}
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
`;

export interface Certificate {
  key: string;
  cert: string;
  expiresAt: Date;
  // SHA-256 of the certificate, colon-separated hex.
  fingerprint: string;
}

// The key and certificate share one owner-only file, so they are replaced
// together and can never be read as a mismatched pair.
export function tlsPath(stateFile: string): string {
  return join(dirname(stateFile), "tls.pem");
}

function pemBlock(pem: string, label: string): string | undefined {
  return pem.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----\\n?`))?.[0];
}

export function readCertificate(path: string): Certificate | undefined {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const key = pemBlock(pem, "PRIVATE KEY");
  const cert = pemBlock(pem, "CERTIFICATE");
  if (!key || !cert) return undefined;
  try {
    const x509 = new X509Certificate(cert);
    if (!x509.checkPrivateKey(createPrivateKey(key))) return undefined;
    return { key, cert, expiresAt: new Date(x509.validTo), fingerprint: x509.fingerprint256 };
  } catch {
    return undefined;
  }
}

function generatePem(dir: string): string {
  // node:crypto writes the key as PKCS#8 with a named curve, which every TLS
  // stack accepts; LibreSSL's own EC key output is rejected by Bun's.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const base = join(dir, `tls-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(`${base}.key`, key, { mode: 0o600 });
    writeFileSync(`${base}.cnf`, OPENSSL_CONFIG);
    const result = spawnSync(
      OPENSSL,
      ["req", "-x509", "-new", "-key", `${base}.key`, "-sha256", "-days", String(VALIDITY_DAYS)].concat([
        "-config",
        `${base}.cnf`,
        "-out",
        `${base}.crt`,
      ]),
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`openssl could not create attn's certificate: ${result.stderr || result.error?.message}`);
    }
    return key + readFileSync(`${base}.crt`, "utf8");
  } finally {
    for (const suffix of [".key", ".cnf", ".crt"]) rmSync(`${base}${suffix}`, { force: true });
  }
}

// Creates a new key and certificate, replacing any that exist.
export function createCertificate(path: string): Certificate {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, generatePem(dirname(path)), { mode: 0o600 });
  renameSync(temp, path);
  return readCertificate(path)!;
}

// Returns the existing certificate, or creates one. When two processes start
// at once, link() lets only the first file in, and both use it.
export function ensureCertificate(path: string): Certificate {
  const existing = readCertificate(path);
  if (existing) return existing;
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, generatePem(dirname(path)), { mode: 0o600 });
  try {
    linkSync(temp, path);
  } catch {
    // Taken by a concurrent start, or an unreadable file is in the way.
    if (!readCertificate(path)) renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return readCertificate(path)!;
}

export function needsRenewal(certificate: Certificate, now = new Date()): boolean {
  return certificate.expiresAt.getTime() - now.getTime() < RENEW_WITHIN_MS;
}

// macOS's `security` tool reads the certificate from a file; it is public, so
// a plain temp file next to tls.pem is fine.
function withCertFile<T>(certificate: Certificate, dir: string, use: (file: string) => T): T {
  const file = join(dir, `attn-cert-${process.pid}.pem`);
  writeFileSync(file, certificate.cert);
  try {
    return use(file);
  } finally {
    rmSync(file, { force: true });
  }
}

// Whether macOS, and so Chrome and Safari, trusts the certificate for
// attn.localhost.
export function isTrusted(certificate: Certificate, dir: string): boolean {
  return withCertFile(
    certificate,
    dir,
    (file) =>
      spawnSync("security", ["verify-cert", "-c", file, "-p", "ssl", "-s", DASHBOARD_HOSTNAME, "-L", "-q"], {
        stdio: "ignore",
      }).status === 0,
  );
}

// Adds the certificate to the login keychain as trusted for TLS. macOS asks
// for the user's password.
export function trustCertificate(certificate: Certificate, dir: string): boolean {
  const keychain = join(homedir(), "Library", "Keychains", "login.keychain-db");
  return withCertFile(
    certificate,
    dir,
    (file) =>
      spawnSync("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", keychain, file], {
        stdio: "inherit",
      }).status === 0,
  );
}
