import { NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/auth";
export async function GET() { const unauthorized = await requireAuth(); return unauthorized ?? NextResponse.json({ ok: true }); }
