import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createCertificate, ensureCertificate, needsRenewal, readCertificate, tlsPath } from "../src/tls";

describe("attn's TLS certificate", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function path(): Promise<string> {
    dir = await mkdtemp(`${tmpdir()}/attn-tls-`);
    return tlsPath(`${dir}/state.json`);
  }

  test("is created once, owner-only, for attn.localhost only, and cannot sign other certificates", async () => {
    const file = await path();
    const certificate = ensureCertificate(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const x509 = new X509Certificate(certificate.cert);
    expect(x509.subjectAltName).toBe("DNS:attn.localhost");
    expect(x509.ca).toBe(false);
    expect(x509.keyUsage).toContain("1.3.6.1.5.5.7.3.1"); // serverAuth
    expect(x509.checkHost("attn.localhost")).toBe("attn.localhost");
    expect(x509.checkHost("evil.example")).toBeUndefined();
    // Apple rejects TLS server certificates valid for more than 825 days.
    const days = (certificate.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(790);
    expect(days).toBeLessThan(825);
    expect(ensureCertificate(file).fingerprint).toBe(certificate.fingerprint);
  });

  test("replaces a file whose key and certificate do not match", async () => {
    const file = await path();
    const first = createCertificate(file);
    const second = createCertificate(`${file}.other`);
    await writeFile(file, second.key + first.cert);
    expect(readCertificate(file)).toBeUndefined();
    const replaced = ensureCertificate(file);
    expect(replaced.fingerprint).not.toBe(first.fingerprint);
    expect(readCertificate(file)?.fingerprint).toBe(replaced.fingerprint);
  });

  test("createCertificate renews in place", async () => {
    const file = await path();
    const first = ensureCertificate(file);
    const renewed = createCertificate(file);
    expect(renewed.fingerprint).not.toBe(first.fingerprint);
    expect(await readFile(file, "utf8")).toContain(renewed.cert.trim());
  });

  test("needs renewal within 30 days of expiry", async () => {
    const certificate = ensureCertificate(await path());
    expect(needsRenewal(certificate)).toBe(false);
    expect(needsRenewal(certificate, new Date(certificate.expiresAt.getTime() - 29 * 86_400_000))).toBe(true);
  });

  test("a missing file reads as no certificate", async () => {
    expect(readCertificate(await path())).toBeUndefined();
  });
});
