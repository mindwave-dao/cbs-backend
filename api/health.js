export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    service: "Mindwave Credits API",
    version: "2.0",
    timestamp: new Date().toISOString()
  });
}
