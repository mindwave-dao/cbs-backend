import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "default-dev-secret-do-not-use-in-prod");
const ALG = 'HS256';

/**
 * Validates Support Admin Credentials from Env
 */
export async function verifySupportAdminCredentials(username, password) {
    const adminUser = process.env.SUPPORT_ADMIN_USERNAME;
    const adminPassHash = process.env.SUPPORT_ADMIN_PASSWORD_HASH;

    if (!adminUser || !adminPassHash) {
        console.error("Missing SUPPORT_ADMIN_USERNAME or SUPPORT_ADMIN_PASSWORD_HASH env vars");
        return false;
    }

    if (username !== adminUser) return false;

    return await bcrypt.compare(password, adminPassHash);
}

/**
 * Signs a JWT for the Support Admin
 */
export async function signAdminToken() {
    return await new SignJWT({ role: 'SUPPORT_ADMIN' })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setExpirationTime('1h') // 1 hour session
        .sign(JWT_SECRET);
}

/**
 * Verifies the JWT from the cookie
 */
export async function verifyAdminToken(token) {
    try {
        const { payload } = await jwtVerify(token, JWT_SECRET);
        return payload.role === 'SUPPORT_ADMIN';
    } catch (e) {
        return false;
    }
}

/**
 * Middleware Helper for API Routes
 * Returns true if authorized, false if not.
 * (Does not send response, just checks)
 */
export async function authenticateSupportAdmin(req) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return false;

    // Parse cookies simply
    const cookies = Object.fromEntries(
        cookieHeader.split('; ').map(c => c.split('='))
    );

    const token = cookies['support_admin_token'];
    if (!token) return false;

    return await verifyAdminToken(token);
}
