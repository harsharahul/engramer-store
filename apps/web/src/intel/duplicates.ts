/**
 * Files stored twice.
 *
 * Every upload already records a BLAKE2b-256 digest of its contents, taken on
 * the device before encryption, so this costs nothing to compute and is a
 * statement rather than a suggestion: matching digests mean the same bytes.
 * That is worth keeping separate from the similarity work that comes later,
 * which compares extracted facts and image embeddings and can only ever
 * suggest. Presenting a certainty and a guess in the same list would make the
 * certainty look negotiable.
 *
 * Nothing here deletes anything. It reports.
 */

export interface DigestedFile {
  id: string;
  /** Absent on anything stored before digests existed. */
  digest?: string;
  trashed: boolean;
  /** Milliseconds since epoch; decides which copy reads as the original. */
  createdAt: number;
}

export interface DuplicateGroup {
  digest: string;
  /** Oldest first, so the original is the copy a default action would keep. */
  fileIds: string[];
}

export function duplicatesByDigest(files: DigestedFile[]): DuplicateGroup[] {
  const byDigest = new Map<string, DigestedFile[]>();
  for (const file of files) {
    // A missing digest is not a value to group by. Files stored before digests
    // existed all lack one, and treating that absence as something they share
    // would declare an entire old library duplicated.
    if (!file.digest || file.trashed) {
      continue;
    }
    const group = byDigest.get(file.digest);
    if (group) {
      group.push(file);
    } else {
      byDigest.set(file.digest, [file]);
    }
  }
  const groups: DuplicateGroup[] = [];
  for (const [digest, members] of byDigest) {
    if (members.length < 2) {
      continue;
    }
    groups.push({
      digest,
      fileIds: [...members]
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((file) => file.id),
    });
  }
  return groups;
}
