# Send Android Push Notifications directly to FCM

KUQuest sends Production Android Push Notifications directly to Firebase Cloud Messaging (FCM); Expo Push Service is not in the delivery path. This gives KUQuest direct control of device destinations, retry, deduplication, delivery status, and provider credentials without adding an Expo dependency to the Android notification path.

Status: accepted.
