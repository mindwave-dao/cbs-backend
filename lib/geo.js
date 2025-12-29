/**
 * Geo restriction utility
 * Restricts access for US users only
 */

export function isGeoRestricted(req) {
  const country = req.headers["x-vercel-ip-country"] || "";
  return country === "US";
}

export function getGeoBlockResponse() {
  return {
    error: "Access restricted to US users only",
    status: 403
  };
}
