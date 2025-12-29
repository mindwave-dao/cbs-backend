import { NextResponse } from 'next/server';

export function middleware(request) {
  const country =
    request.geo?.country ||
    request.headers.get("x-vercel-ip-country");

  if (country === "US") {
    return NextResponse.redirect(new URL('/restricted', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/((?!api|_next/static|_next/image|favicon.ico).*)',
};
