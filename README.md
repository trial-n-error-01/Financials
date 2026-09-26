# Financials

A Next.js expense dashboard skeleton with Firebase Authentication and Cloud Firestore.

## Local setup

1. Create a Firebase project and a Firebase Web App.
2. Enable **Email/Password** under Authentication providers.
3. Create a Cloud Firestore database and publish `firestore.rules`.
4. Copy `.env.example` to `.env.local` and fill in the Web App configuration values.
5. Start the development server:

```bash
npm run dev
```

Open http://localhost:3000. When the Firebase variables are present, the app renders sign-in and sign-up UI before showing the dashboard. Without them, the dashboard remains available as a configuration preview.

To publish the included Firestore rules, use the Firebase Console Rules tab or run `firebase deploy --only firestore:rules` from a configured Firebase CLI project.

## Bulk expense upload

Use **Import file** on the dashboard to preview and import a CSV. Export Excel or Numbers as CSV first. The first four headers must be exactly `Date`, `Merchant`, `Category`, and `Amount`, in that order. Optional headers are `Payment Method` and `Notes`. Categories found in the CSV are automatically added to the account and persisted in Firebase.

## Available scripts

```bash
npm run dev
npm run lint
npm run build
```

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
