import { Readable } from 'stream';
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { Router, type IRouter, type Request, type Response } from 'express';

import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import {
  db,
  vendorsTable,
  authorizationsTable,
  clientsTable,
  invoicesTable,
} from '@workspace/db';

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';
import { requireAuth, audit } from '../lib/auth';
import { notDeleted } from '../lib/serializers';

const router: IRouter = Router();

/**
 * Authorize a user to fetch a private object at `objectPath` (e.g.
 * "/objects/uploads/<id>"). Returns true when access is permitted:
 *  - staff: any object
 *  - vendor: only their own vendor's w9DocumentUrl
 *  - parent_guardian/self: only POS PDFs of authorizations for their client
 *  - service_coordinator: only POS PDFs of authorizations for their clients
 */
async function canAccessPrivateObject(
  user: { role: string; id: string; linkedRecordType: string | null; linkedRecordId: string | null },
  objectPath: string,
): Promise<boolean> {
  if (user.role === 'staff') return true;

  if (user.role === 'vendor' && user.linkedRecordType === 'vendor' && user.linkedRecordId) {
    const [vendor] = await db
      .select({ w9DocumentUrl: vendorsTable.w9DocumentUrl })
      .from(vendorsTable)
      .where(eq(vendorsTable.id, user.linkedRecordId));
    if (vendor?.w9DocumentUrl === objectPath) return true;
    const invoiceDocs = await db
      .select({ documentUrl: invoicesTable.documentUrl })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.vendorId, user.linkedRecordId),
          isNotNull(invoicesTable.documentUrl),
          notDeleted(invoicesTable),
        ),
      );
    return invoiceDocs.some((r) => r.documentUrl === objectPath);
  }

  if (
    (user.role === 'parent_guardian' || user.role === 'self') &&
    user.linkedRecordType === 'client' &&
    user.linkedRecordId
  ) {
    const rows = await db
      .select({ posPdfUrl: authorizationsTable.posPdfUrl })
      .from(authorizationsTable)
      .where(
        and(
          eq(authorizationsTable.clientId, user.linkedRecordId),
          isNotNull(authorizationsTable.posPdfUrl),
          notDeleted(authorizationsTable),
        ),
      );
    if (rows.some((r) => r.posPdfUrl === objectPath)) return true;
    const invoiceDocs = await db
      .select({ documentUrl: invoicesTable.documentUrl })
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.clientId, user.linkedRecordId),
          isNotNull(invoicesTable.documentUrl),
          notDeleted(invoicesTable),
        ),
      );
    return invoiceDocs.some((r) => r.documentUrl === objectPath);
  }

  if (user.role === 'service_coordinator') {
    const clients = await db
      .select({ id: clientsTable.id })
      .from(clientsTable)
      .where(and(eq(clientsTable.assignedCoordinatorId, user.id), notDeleted(clientsTable)));
    const clientIds = clients.map((c) => c.id);
    if (clientIds.length === 0) return false;
    const rows = await db
      .select({ posPdfUrl: authorizationsTable.posPdfUrl })
      .from(authorizationsTable)
      .where(
        and(
          inArray(authorizationsTable.clientId, clientIds),
          isNotNull(authorizationsTable.posPdfUrl),
          notDeleted(authorizationsTable),
        ),
      );
    if (rows.some((r) => r.posPdfUrl === objectPath)) return true;
    const invoiceDocs = await db
      .select({ documentUrl: invoicesTable.documentUrl })
      .from(invoicesTable)
      .where(
        and(
          inArray(invoicesTable.clientId, clientIds),
          isNotNull(invoicesTable.documentUrl),
          notDeleted(invoicesTable),
        ),
      );
    return invoiceDocs.some((r) => r.documentUrl === objectPath);
  }

  return false;
}
const objectStorageService = new ObjectStorageService();

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
]);

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * Requires auth middleware so public callers cannot mint write-capable URLs.
 */
router.post(
  '/storage/uploads/request-url',
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;

      if (size > MAX_UPLOAD_BYTES) {
        res.status(400).json({ error: 'File exceeds the 10MB size limit' });
        return;
      }
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        res.status(400).json({
          error: 'Unsupported file type. Allowed: PDF, PNG, JPG',
        });
        return;
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();
      const objectPath =
        objectStorageService.normalizeObjectEntityPath(uploadURL);

      await audit(
        req.user?.id ?? null,
        'file.upload_requested',
        'upload',
        objectPath,
        `${name} (${contentType}, ${size} bytes)`,
      );

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, 'Error generating upload URL');
      res.status(500).json({ error: 'Failed to generate upload URL' });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join('/') : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const response = await objectStorageService.downloadObject(file);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, 'Error serving public object');
      res.status(500).json({ error: 'Failed to serve public object' });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get('/storage/objects/*path', requireAuth, async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join('/') : raw;
    const objectPath = `/objects/${wildcardPath}`;

    // Authorize before revealing whether the object exists. Staff may fetch any
    // object; other roles are limited to objects tied to their own records.
    const allowed = await canAccessPrivateObject(req.user!, objectPath);
    if (!allowed) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const objectFile =
      await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, 'Object not found');
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    req.log.error({ err: error }, 'Error serving object');
    res.status(500).json({ error: 'Failed to serve object' });
  }
});

export default router;
