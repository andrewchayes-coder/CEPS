import { ObjectStorageService } from "./objectStorage";

const MAX_POS_PDF_BYTES = 10 * 1024 * 1024;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export class PosUploadValidationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PosUploadValidationError";
  }
}

export async function validateOwnedPosPdf(
  storage: ObjectStorageService,
  ownerId: string,
  rawPath: string,
): Promise<{ objectPath: string; file: Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>> }> {
  let objectPath: string;
  try {
    objectPath = storage.normalizeObjectEntityPath(rawPath);
  } catch {
    throw new PosUploadValidationError(400, "Invalid POS PDF object path.");
  }
  const ownedUpload = new RegExp(`^/objects/uploads/${ownerId}/${UUID_PATTERN}$`, "i");
  if (!ownedUpload.test(objectPath)) {
    throw new PosUploadValidationError(403, "POS PDF must be an upload owned by the submitting staff user.");
  }

  let file: Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;
  let metadata: Record<string, unknown>;
  try {
    file = await storage.getObjectEntityFile(objectPath);
    const [actualMetadata] = await file.getMetadata();
    metadata = actualMetadata as Record<string, unknown>;
  } catch {
    throw new PosUploadValidationError(400, "POS PDF upload is missing or unavailable.");
  }
  const actualContentType = String(metadata.contentType ?? "").split(";")[0].trim().toLowerCase();
  const actualSize = Number(metadata.size);
  if (actualContentType !== "application/pdf") {
    throw new PosUploadValidationError(400, "Uploaded POS file must have PDF content type.");
  }
  if (!Number.isSafeInteger(actualSize) || actualSize < 1 || actualSize > MAX_POS_PDF_BYTES) {
    throw new PosUploadValidationError(400, "Uploaded POS PDF must be no larger than 10MB.");
  }
  return { objectPath, file };
}

export async function validatePosBatchFiles(
  storage: ObjectStorageService,
  ownerId: string,
  files: Array<{ posPdfUrl: string; sourceFileName: string }>,
): Promise<Array<{ posPdfUrl: string; sourceFileName: string }>> {
  const validated: Array<{ posPdfUrl: string; sourceFileName: string } | undefined> = new Array(files.length);
  let next = 0;
  const validateWorker = async () => {
    while (true) {
      const index = next++;
      if (index >= files.length) return;
      const input = files[index]!;
      const { objectPath } = await validateOwnedPosPdf(storage, ownerId, input.posPdfUrl);
      validated[index] = { posPdfUrl: objectPath, sourceFileName: input.sourceFileName };
    }
  };
  await Promise.all([validateWorker(), validateWorker(), validateWorker()]);
  return validated.map((file) => file!);
}