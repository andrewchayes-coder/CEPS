import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import invitesRouter from "./invites";
import usersRouter from "./users";
import clientsRouter from "./clients";
import referralsRouter from "./referrals";
import authorizationsRouter from "./authorizations";
import invoicesRouter from "./invoices";
import paymentsRouter from "./payments";
import feesRouter from "./fees";
import vendorsRouter from "./vendors";
import dashboardRouter from "./dashboard";
import storageRouter from "./storage";
import importsRouter from "./imports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(invitesRouter);
router.use(usersRouter);
router.use(clientsRouter);
router.use(referralsRouter);
router.use(authorizationsRouter);
router.use(invoicesRouter);
router.use(paymentsRouter);
router.use(feesRouter);
router.use(vendorsRouter);
router.use(dashboardRouter);
router.use(storageRouter);
router.use(importsRouter);

export default router;
