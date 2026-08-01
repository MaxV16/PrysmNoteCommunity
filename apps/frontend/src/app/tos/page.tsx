import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | Prysm Note",
};

export default function TosPage() {
  return (
    <div className="min-h-screen bg-base p-8">
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-2">Terms of Service</h1>
          <p className="text-sm text-muted">Last updated: July 2026</p>
        </div>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">1. Acceptance of Terms</h2>
          <p>By accessing or using Prysm Note (&quot;the Service&quot;), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">2. Description of Service</h2>
          <p>Prysm Note is an AI-powered task management application that helps users organize, prioritize, and complete their work. The Service is provided under an open-core model, provided as open source under the AGPL-3.0 license.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">3. User Accounts</h2>
          <p>You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You must notify us immediately of any unauthorized use.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">4. Acceptable Use</h2>
          <p>You agree not to:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Use the Service for any illegal purpose.</li>
            <li>Attempt to gain unauthorized access to any part of the Service.</li>
            <li>Interfere with or disrupt the integrity or performance of the Service.</li>
            <li>Upload or transmit viruses, malware, or any malicious code.</li>
            <li>Use the Service to store or process sensitive personal data beyond its intended purpose.</li>
          </ul>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">5. Intellectual Property</h2>
          <p>The Community Edition of Prysm Note is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). The Enterprise Edition and associated proprietary features are licensed separately under a commercial license. You retain ownership of your task data and content.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">6. Limitation of Liability</h2>
          <p>Prysm Note is provided &quot;as is&quot; without warranty of any kind. In no event shall the creators or contributors be liable for any damages arising from the use of the Service.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">7. Changes to Terms</h2>
          <p>We reserve the right to modify these terms at any time. Users will be notified of material changes via email or in-app notification. Continued use after changes constitutes acceptance of the new terms.</p>
        </section>

        <section className="space-y-4 text-sm text-secondary leading-relaxed">
          <h2 className="text-lg font-semibold text-primary">8. Contact</h2>
          <p>For questions about these terms, contact us at:</p>
          <p className="text-accent">legal@prysmnote.com</p>
        </section>
      </div>
    </div>
  );
}
