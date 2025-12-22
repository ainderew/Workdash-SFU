import jwt from 'jsonwebtoken';

export interface JwtPayload {
  userId: number;
  email: string;
  name: string;
  iat?: number;
  exp?: number;
}

export class JwtUtil {
  private static secret = process.env.JWT_SECRET || 'fallback-secret-dev-only';
  private static expiresIn = process.env.JWT_EXPIRES_IN || '7d';

  static sign(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'fallback-secret-dev-only') {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET must be set in production');
      }
      console.warn('⚠️  Using fallback JWT secret - DO NOT use in production');
    }

    return jwt.sign(payload, this.secret, { expiresIn: this.expiresIn });
  }

  static verify(token: string): JwtPayload {
    return jwt.verify(token, this.secret) as JwtPayload;
  }

  static decode(token: string): JwtPayload | null {
    return jwt.decode(token) as JwtPayload | null;
  }
}
