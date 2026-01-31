import { google } from "googleapis";

let sheets;

export function getSheetsClient() {
    if (sheets) return sheets;

    if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
        throw new Error("GOOGLE_SHEETS_CREDENTIALS missing");
    }

    const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    sheets = google.sheets({ version: "v4", auth });
    return sheets;
}

// Backward compatibility alias if needed, but getSheetsClient is preferred
export const getSheets = getSheetsClient;
