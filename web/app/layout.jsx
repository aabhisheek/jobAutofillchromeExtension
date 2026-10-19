import "./globals.css";

export const metadata = {
  title: "Job Autofill — Cloud",
  description: "Your synced job-application board, profile and resume."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
