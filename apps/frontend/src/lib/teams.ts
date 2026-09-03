"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface TeamMember {
  user_id: string;
  email: string | null;
  role: "owner" | "admin" | "member";
}

export interface TeamProject {
  id: string;
  name: string;
}

export interface Team {
  id: string;
  name: string;
  owner_id: string;
  members: TeamMember[];
  projects: TeamProject[];
  my_role?: string;
}

export interface TeamInvite {
  token: string;
  team_id: string;
  team_name: string;
  role: string;
}

export function useTeams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ teams: Team[]; invites: TeamInvite[] }>("/teams/");
      setTeams(data.teams);
      setInvites(data.invites);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createTeam = useCallback(
    async (name: string) => {
      await api.post<Team>("/teams/", { name });
      await refresh();
    },
    [refresh]
  );

  const renameTeam = useCallback(
    async (teamId: string, name: string) => {
      await api.patch(`/teams/${teamId}`, { name });
      await refresh();
    },
    [refresh]
  );

  const deleteTeam = useCallback(
    async (teamId: string) => {
      await api.delete(`/teams/${teamId}`);
      await refresh();
    },
    [refresh]
  );

  const inviteMember = useCallback(
    async (teamId: string, email: string, role = "member") => {
      await api.post(`/teams/${teamId}/members`, { email, role });
      await refresh();
    },
    [refresh]
  );

  const changeRole = useCallback(
    async (teamId: string, userId: string, role: string) => {
      await api.patch(`/teams/${teamId}/members/${userId}`, { role });
      await refresh();
    },
    [refresh]
  );

  const removeMember = useCallback(
    async (teamId: string, userId: string) => {
      await api.delete(`/teams/${teamId}/members/${userId}`);
      await refresh();
    },
    [refresh]
  );

  const addProject = useCallback(
    async (teamId: string, name: string) => {
      await api.post(`/teams/${teamId}/projects`, { name });
      await refresh();
    },
    [refresh]
  );

  const removeProject = useCallback(
    async (teamId: string, projectId: string) => {
      await api.delete(`/teams/${teamId}/projects/${projectId}`);
      await refresh();
    },
    [refresh]
  );

  const acceptInvite = useCallback(
    async (token: string) => {
      await api.post(`/teams/invites/${token}/accept`);
      await refresh();
    },
    [refresh]
  );

  const declineInvite = useCallback(
    async (token: string) => {
      await api.post(`/teams/invites/${token}/decline`);
      await refresh();
    },
    [refresh]
  );

  return {
    teams,
    invites,
    loading,
    refresh,
    createTeam,
    renameTeam,
    deleteTeam,
    inviteMember,
    changeRole,
    removeMember,
    addProject,
    removeProject,
    acceptInvite,
    declineInvite,
  };
}
