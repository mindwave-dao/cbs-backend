import { setCors } from "../lib/cors.js";

export default function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  res.status(200).json({
    status: "ok",
    service: "NILA API",
    version: "2.0",
    timestamp: new Date().toISOString()
  });
}
