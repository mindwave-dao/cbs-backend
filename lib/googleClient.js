import { google } from "googleapis";

let client;

export function getGoogleClient() {
    if (!client) {
        if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
            console.error("[GOOGLE CLIENT] Missing GOOGLE_SHEETS_CREDENTIALS");
            return null;
        }
        try {
            const auth = new google.auth.GoogleAuth({
                credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS),
                scopes: ["https://www.googleapis.com/auth/spreadsheets"],
            });
            client = google.sheets({ version: "v4", auth });
        } catch (error) {
            console.error("[GOOGLE CLIENT] Initialization failed:", error);
            return null;
        }
    }
    return client;
}
