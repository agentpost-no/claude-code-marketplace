declare module "libsodium-wrappers-sumo" {
  const sodium: {
    ready: Promise<void>;
    crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array };
    crypto_box_seal_open(
      ciphertext: Uint8Array,
      publicKey: Uint8Array,
      privateKey: Uint8Array
    ): Uint8Array;
    crypto_auth_keygen(): Uint8Array;
    crypto_auth(message: Uint8Array, key: Uint8Array): Uint8Array;
    to_base64(input: Uint8Array, variant: number): string;
    from_base64(input: string, variant: number): Uint8Array;
    to_hex(input: Uint8Array): string;
    from_hex(input: string): Uint8Array;
    base64_variants: {
      ORIGINAL: number;
      ORIGINAL_NO_PADDING: number;
      URLSAFE: number;
      URLSAFE_NO_PADDING: number;
    };
    SODIUM_VERSION_STRING: string;
  };
  export = sodium;
}
