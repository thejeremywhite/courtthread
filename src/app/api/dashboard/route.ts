import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/db/queries";

export async function GET() {
  try {
    const data = await getDashboardData();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({
      conversations: 0, messages: 0, participants: 0, sources: 0,
      bookmarks: 0, recentConversations: [], recentSources: [],
    });
  }
}
