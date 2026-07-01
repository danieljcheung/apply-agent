import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

type VaultEnvelope = {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export class Vault<TData extends Record<string, unknown> = Record<string, unknown>> {
  constructor(
    private readonly filePath: string,
    private readonly password: string
  ) {}

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async save(data: TData): Promise<void> {
    if (!this.password) {
      throw new Error('Vault password is required');
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(this.password, salt, 100000, 32, 'sha256');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(data);
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const vaultPayload: VaultEnvelope = {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      ciphertext
    };

    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.${path.basename(this.filePath)}.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(tempPath, 'w');
      try {
        await handle.writeFile(JSON.stringify(vaultPayload), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tempPath, this.filePath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw err;
    }
  }

  async load(): Promise<TData> {
    if (!this.password) {
      throw new Error('Vault password is required');
    }
    const content = await fs.readFile(this.filePath, 'utf8');
    const vaultPayload = JSON.parse(content) as VaultEnvelope;

    try {
      const salt = Buffer.from(vaultPayload.salt, 'hex');
      const iv = Buffer.from(vaultPayload.iv, 'hex');
      const tag = Buffer.from(vaultPayload.tag, 'hex');
      const key = crypto.pbkdf2Sync(this.password, salt, 100000, 32, 'sha256');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);

      let plaintext = decipher.update(vaultPayload.ciphertext, 'hex', 'utf8');
      plaintext += decipher.final('utf8');

      return JSON.parse(plaintext) as TData;
    } catch (err) {
      throw new Error('Invalid vault password or corrupted vault ciphertext');
    }
  }

  async update(updateFn: (data: Partial<TData>) => TData | Promise<TData>): Promise<TData> {
    const data = (await this.exists()) ? await this.load() : {};
    const updatedData = await updateFn(data as Partial<TData>);
    await this.save(updatedData);
    return updatedData;
  }

  encryptBuffer(buffer: Buffer): Buffer {
    if (!this.password) {
      throw new Error('Vault password is required');
    }
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(this.password, salt, 100000, 32, 'sha256');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, tag, ciphertext]);
  }

  decryptBuffer(encryptedBuffer: Buffer): Buffer {
    if (!this.password) {
      throw new Error('Vault password is required');
    }
    const salt = encryptedBuffer.subarray(0, 16);
    const iv = encryptedBuffer.subarray(16, 28);
    const tag = encryptedBuffer.subarray(28, 44);
    const ciphertext = encryptedBuffer.subarray(44);
    const key = crypto.pbkdf2Sync(this.password, salt, 100000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
