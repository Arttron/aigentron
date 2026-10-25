import { useState } from 'react';
import { AppHeader, BackLink, Tabs, type TabDef } from '@/components/ui';
import { GeneralSettingsForm } from '@/components/settings/GeneralSettingsForm';
import { SecuritySettings } from '@/components/settings/SecuritySettings';
import { SessionsSettings } from '@/components/settings/SessionsSettings';
import { AccessSettings } from '@/components/settings/AccessSettings';
import { CloudflareAccessSettings } from '@/components/settings/CloudflareAccessSettings';
import { WebServerSettings } from '@/components/settings/WebServerSettings';
import { UpdateSettings } from '@/components/settings/UpdateSettings';
import { LiteLlmRoutes } from '@/components/settings/LiteLlmRoutes';
import { ProvidersManager } from '@/components/ProvidersManager';
import { McpManager } from '@/components/McpManager';
import { McpEndpointManager } from '@/components/settings/McpEndpointManager';
import { ChannelsManager } from '@/components/ChannelsManager';
import { UsersManager } from '@/components/UsersManager';
import { SchedulesManager } from '@/components/SchedulesManager';
import { DiskSettings } from '@/components/settings/DiskSettings';
import { TitleSettings } from '@/components/settings/TitleSettings';
import { ApprovalSettings } from '@/components/settings/ApprovalSettings';
import { AlertSoundSettings } from '@/components/settings/AlertSoundSettings';
import { RunLimitSettings } from '@/components/settings/RunLimitSettings';
import { VisionSettings } from '@/components/settings/VisionSettings';
import { VoiceSettings } from '@/components/settings/VoiceSettings';

/**
 * Grouped by what the person is doing: the everyday look and upkeep (General), how agents work (Work), who may get in (Security), the AI behind them
 * (Providers, LiteLLM, Voice & vision), what they connect to (MCP, Channels, Schedules) and who the people are (Users).
 */
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'work', label: 'Work' },
  { id: 'security', label: 'Security' },
  { id: 'providers', label: 'Providers' },
  { id: 'litellm', label: 'LiteLLM' },
  { id: 'mcp', label: 'MCP' },
  { id: 'channels', label: 'Channels' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'voice', label: 'Voice & vision' },
  { id: 'users', label: 'Users' },
] as const satisfies ReadonlyArray<TabDef<string>>;

type TabId = (typeof TABS)[number]['id'];

export function SettingsPage() {
  const [tab, setTab] = useState<TabId>('general');

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="⚙ Settings" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'general' && (
        <>
          <UpdateSettings />
          <GeneralSettingsForm sections={['display']} />
          <AlertSoundSettings />
          <TitleSettings />
          <DiskSettings />
        </>
      )}
      {tab === 'work' && (
        <>
          <ApprovalSettings />
          <RunLimitSettings />
          <GeneralSettingsForm sections={['repo', 'verify', 'queue', 'approvals', 'instructions', 'escalations']} />
        </>
      )}
      {tab === 'security' && (
        <>
          <SecuritySettings />
          <SessionsSettings />
          <AccessSettings />
          <CloudflareAccessSettings />
          <WebServerSettings />
        </>
      )}
      {tab === 'providers' && <ProvidersManager />}
      {tab === 'litellm' && <LiteLlmRoutes />}
      {tab === 'mcp' && (
        <>
          <McpManager />
          <McpEndpointManager />
        </>
      )}
      {tab === 'channels' && <ChannelsManager />}
      {tab === 'schedules' && <SchedulesManager />}
      {tab === 'voice' && (
        <>
          <VoiceSettings />
          <VisionSettings />
        </>
      )}
      {tab === 'users' && <UsersManager />}
    </>
  );
}
