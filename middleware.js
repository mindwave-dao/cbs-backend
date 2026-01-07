export default function middleware(request) {
  const country =
    request.geo?.country ||
    request.headers.get("x-vercel-ip-country");

  // Block ONLY U.S. users
  if (country === "US") {
    return new Response(null, {
      status: 307,
      headers: {
        Location: "/restricted",
      },
    });
  }

  // Allow all other countries (including CA and unknown)
  return;
}

export const config = {
  matcher: ["/buy", "/checkout"],
};
