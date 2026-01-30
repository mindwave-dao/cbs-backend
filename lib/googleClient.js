import { google } from "googleapis";

let sheets;

export function getSheets() {
    if (sheets) return sheets;

    const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    sheets = google.sheets({ version: "v4", auth });
    return sheets;
}
