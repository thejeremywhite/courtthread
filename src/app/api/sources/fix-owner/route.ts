import { NextRequest, NextResponse } from "next/server";
import { detectAndApplyOwner, getImportBatches } from "@/lib/db/queries";

// Fixes already-imported data whose "outgoing" (right-side) messages were never set
// correctly (e.g. imported before owner auto-detection existed, or the archive belongs
// to someone other than the default ownerName). Two modes:
//   { sourceIds: [...] }  -> detect + apply across exactly these sources (one import)
//   {}                    -> re-run detection per IMPORT BATCH across every source in
//                            the database (bulk fix-up for existing data)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const explicitIds: string[] | undefined = body.sourceIds;

    if (explicitIds && explicitIds.length > 0) {
      const owner = await detectAndApplyOwner(explicitIds);
      return NextResponse.json({
        results: [{ sourceIds: explicitIds, owner, applied: owner !== null }],
      });
    }

    const batches = await getImportBatches();
    const results: Array<{ sourceIds: string[]; owner: string | null; applied: boolean }> = [];
    for (const ids of batches) {
      const owner = await detectAndApplyOwner(ids);
      results.push({ sourceIds: ids, owner, applied: owner !== null });
    }
    return NextResponse.json({ results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
