import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import clientsRouter from "./clients";
import referralsRouter from "./referrals";
import authorizationsRouter from "./authorizations";
import invoicesRouter from "./invoices";
import paymentsRouter from "./payments";
import vendorsRouter from "./vendors";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(clientsRouter);
router.use(referralsRouter);
router.use(authorizationsRouter);
router.use(invoicesRouter);
router.use(paymentsRouter);
router.use(vendorsRouter);
router.use(dashboardRouter);

export default router;
