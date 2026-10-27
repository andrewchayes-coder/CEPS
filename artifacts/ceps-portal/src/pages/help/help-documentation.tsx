import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { getVisibleRoleDocs, type RoleDoc } from './content';
import { formatDate, formatDateTime, formatMonth } from '@/lib/dates';
import { ProtectedData } from '@/components/protected-data';

export function HelpDocumentation({ role }: { role?: string }) {
  const docs = getVisibleRoleDocs(role);
  const defaultRole = docs.find((doc) => doc.role === role)?.role ?? docs[0]?.role;
  const [selection, setSelection] = useState<{ role?: string; tab?: string }>({ role, tab: defaultRole });
  // Reset to the new role's own guide on a role change, without an
  // effect that could briefly render a guide selected by the previous user.
  const activeTab = selection.role === role && docs.some((doc) => doc.role === selection.tab)
    ? selection.tab : defaultRole;

  return (
    <div className="space-y-6" data-testid="page-help">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-help-title">Help &amp; Documentation</h1>
        <p className="text-muted-foreground mt-1">
          {role === 'staff'
            ? 'User stories and step-by-step workflows for every role in the CEPS program.'
            : role === 'service_coordinator'
              ? 'Workflows for your caseload and guides to help families and self-representing participants.'
              : 'User stories and step-by-step workflows for your role in the CEPS program.'}
        </p>
      </div>
      {docs.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="help-date-formats">
          Dates use MM/DD/YYYY (for example, <ProtectedData>{formatDate('2026-10-22')}</ProtectedData>).
          Dates with times use Pacific time (for example, <ProtectedData>{formatDateTime('2026-10-22T22:05:00Z')}</ProtectedData>).
          Service months use MM/YYYY (for example, <ProtectedData>{formatMonth('2026-10')}</ProtectedData>).
          Native date and month inputs follow your computer&apos;s settings.
        </p>
      )}
      {docs.length === 0 ? (
        <p className="text-muted-foreground">No help guide is available for this account.</p>
      ) : docs.length === 1 ? (
        <RoleGuide doc={docs[0]} ownRole={role} />
      ) : (
        <Tabs value={activeTab} onValueChange={(tab) => setSelection({ role, tab })}>
          <TabsList className="flex flex-wrap h-auto">
            {docs.map((doc) => (
              <TabsTrigger key={doc.role} value={doc.role} data-testid={`tab-help-${doc.role}`}>
                {doc.label}
                {role === doc.role && <Badge variant="secondary" className="ml-2">Your role</Badge>}
              </TabsTrigger>
            ))}
          </TabsList>
          {docs.map((doc) => (
            <TabsContent key={doc.role} value={doc.role} className="mt-6">
              <RoleGuide doc={doc} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

function RoleGuide({ doc, ownRole }: { doc: RoleDoc; ownRole?: string }) {
  return (
    <section className="space-y-6" data-testid={`guide-help-${doc.role}`}>
      <Card>
        <CardHeader>
          <CardTitle>
            {doc.label} Overview
            {ownRole === doc.role && <Badge variant="secondary" className="ml-2">Your role</Badge>}
          </CardTitle>
          <CardDescription>{doc.overview}</CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>User Stories</CardTitle>
          <CardDescription>What this role needs from the portal, and why.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3">
            {doc.stories.map((story, i) => (
              <li key={i} className="rounded-md border p-3 text-sm" data-testid={`story-${doc.role}-${i}`}>
                <span className="text-muted-foreground">As </span>
                <span className="font-medium">{story.as}</span>
                <span className="text-muted-foreground">, I want </span>
                <span className="font-medium">{story.want}</span>
                <span className="text-muted-foreground">, so that </span>
                <span>{story.soThat}.</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Workflows</h2>
        {doc.workflows.map((wf, i) => (
          <Card key={i} data-testid={`workflow-${doc.role}-${i}`}>
            <CardHeader>
              <CardTitle className="text-base">{wf.name}</CardTitle>
              <CardDescription>{wf.summary}</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="space-y-3">
                {wf.steps.map((step, j) => (
                  <li key={j} className="flex gap-3 text-sm">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
                      {j + 1}
                    </span>
                    <div>
                      <p className="font-medium">{step.title}</p>
                      <p className="text-muted-foreground">{step.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
