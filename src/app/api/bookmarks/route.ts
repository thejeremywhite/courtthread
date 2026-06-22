import { NextRequest, NextResponse } from "next/server";
import { getBookmarks, toggleBookmark } from "@/lib/db/queries";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId") || undefined;
  const bookmarks = await getBookmarks(conversationId);
  return NextResponse.json({ bookmarks });
}

export async function POST(request: NextRequest) {
  const { messageId, conversationId, note } = await request.json();
  if (!messageId || !conversationId) {
    return NextResponse.json({ error: "messageId and conversationId required" }, { status: 400 });
  }
  const result = await toggleBookmark(messageId, conversationId, note);
  return NextResponse.json(result);
}
