import { randomBytes } from 'node:crypto';

// No look-alike characters (0/O, 1/l/I), so a password read out or copied by hand works first time.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random 16-character password (about 94 bits), for new or reset admin accounts. */
export const generatePassword = () => [...randomBytes(16)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
