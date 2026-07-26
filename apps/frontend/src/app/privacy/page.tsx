import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | Prysm Note",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-base p-8">
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-2">Privacy Policy</h1>
          <p className="text-sm text-muted">Last updated: July 2026</p>
        </div>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">1. Information We Collect</h2>
          <p>When you use Prysm Note, we collect the following information:</p>
          <ul className="list-disc list-inside space-y-1">
            <li><strong className="text-primary">Account Data:</strong> Email address and display name for authentication and communication.</li>
            <li><strong className="text-primary">Task Data:</strong> Tasks, projects, tags, notes, and other productivity content you create within the app.</li>
            <li><strong className="text-primary">API Keys:</strong> LLM provider API keys (OpenAI, Gemini, DeepSeek) are encrypted using Fernet (AES-128) before being stored on our servers. They are decrypted in-memory only when needed for AI requests and are never logged or persisted in plaintext.</li>
            <li><strong className="text-primary">Usage Data:</strong> Anonymous usage statistics to improve the application experience.</li>
          </ul>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">2. How We Use Your Data</h2>
          <ul className="list-disc list-inside space-y-1">
            <li>To provide and maintain the Prysm Note service.</li>
            <li>To authenticate your identity and secure your account.</li>
            <li>To process AI-powered features using your provided API keys.</li>
            <li>To communicate important service updates and security notices.</li>
            <li>To improve and optimize the application.</li>
          </ul>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">3. Data Storage and Security</h2>
          <p>Your data is stored on secure servers with industry-standard encryption in transit (TLS) and at rest. API keys are additionally encrypted using Fernet symmetric encryption. We implement Row-Level Security (RLS) in our database to ensure your data is isolated from other users.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">4. GDPR Compliance</h2>
          <p>If you are located in the European Economic Area (EEA), you have the following rights under the General Data Protection Regulation (GDPR):</p>
          <ul className="list-disc list-inside space-y-1">
            <li><strong className="text-primary">Right to Access:</strong> Request a copy of your personal data.</li>
            <li><strong className="text-primary">Right to Rectification:</strong> Correct inaccurate or incomplete data.</li>
            <li><strong className="text-primary">Right to Erasure:</strong> Request deletion of your data.</li>
            <li><strong className="text-primary">Right to Data Portability:</strong> Receive your data in a machine-readable format.</li>
            <li><strong className="text-primary">Right to Object:</strong> Object to processing of your personal data.</li>
          </ul>
          <p>To exercise any of these rights, please contact us at privacy@prysmnote.com.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">5. Third-Party Services</h2>
          <p>Prysm Note integrates with third-party LLM providers (OpenAI, Google, DeepSeek) using your provided API keys. When you use AI features, relevant task data is sent to the chosen provider for processing. We do not share your data with any other third parties.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">6. Contact</h2>
          <p>For privacy-related inquiries, contact us at:</p>
          <p className="text-accent">privacy@prysmnote.com</p>
        </section>
      </div>
    </div>
  );
}
