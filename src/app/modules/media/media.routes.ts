import express from 'express';
import mediaController from './media.controller';

const router = express.Router();

// No user auth: EventBridge authenticates with the shared secret header.
router.post('/mediaconvert', mediaController.mediaConvertWebhook);

export const mediaWebhookRoutes = router;
