import { NextResponse } from "next/server";
import { draftSchema, pushDraft } from "../../../../lib/wechat/draft";
import { sameOrigin, apiError } from "../../../../lib/wechat/http";
import { requireAuth } from "../../../../lib/auth";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try { sameOrigin(request); return NextResponse.json(await pushDraft(draftSchema.parse(await request.json()))); }
  catch (error) { return apiError(error); }
}
