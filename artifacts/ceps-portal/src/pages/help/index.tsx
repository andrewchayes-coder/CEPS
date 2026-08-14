import { useState } from 'react';
import { useAuth } from '@/components/auth/auth-provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { roleDocs } from './content';

export default function HelpPage() {
  const { user } = useAuth();
  const defaultRole = roleDocs.some((d) => d.role === user?.role) ? user!.role : roleDocs[0].role;
  const [tab, setTab] = useState(defaultRole);

  return (
    <div className="space-y-6" data-testid="page-help">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-help-title">Help &amp; Documentation</h1>
        <p className="text-muted-foreground mt-1">
          User stories and step-by-step workflows for every role in the CEPS program.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto">
          {roleDocs.map((doc) => (
            <TabsTrigger key={doc.role} value={doc.role} data-testid={`tab-help-${doc.role}`}>
              {doc.label}
              {user?.role === doc.role && (
                <Badge variant="secondary" className="ml-2">Your role</Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {roleDocs.map((doc) => (
          <TabsContent key={doc.role} value={doc.role} className="space-y-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle>{doc.label} Overview</CardTitle>
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
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
