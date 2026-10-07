import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

// Trade tags and their groups (routes/tags.js), shared by all accounts:
// loaded once, refreshed after anything changes them.
const TagsContext = createContext({
  groups: [], tags: [], tagsById: new Map(), groupsById: new Map(), loaded: false,
  refreshTags: async () => {}, createTag: async () => null, tagsOfTrade: () => [],
});

const api = (path, options = {}) => fetch(`${process.env.REACT_APP_API_URL}/api${path}`, {
  ...options,
  headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
}).then(async res => {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
});

export function TagsProvider({ children }) {
  const [data, setData] = useState({ groups: [], tags: [], loaded: false });

  const refreshTags = useCallback(async () => {
    try {
      const { groups, tags } = await api('/tags');
      setData({ groups: groups || [], tags: tags || [], loaded: true });
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  }, []);

  useEffect(() => { refreshTags(); }, [refreshTags]);

  // The tag with this name (any case), made in groupId if it's new.
  const createTag = useCallback(async (name, groupId = null) => {
    const tag = await api('/tags', { method: 'POST', body: JSON.stringify({ name, group_id: groupId }) });
    await refreshTags();
    return tag;
  }, [refreshTags]);

  const value = useMemo(() => {
    const tagsById = new Map(data.tags.map(t => [t.id, t]));
    const groupsById = new Map(data.groups.map(g => [g.id, g]));
    // A trade's tags with their group, in group order then by name.
    const tagsOfTrade = (tagIds) => (tagIds || [])
      .map(id => tagsById.get(Number(id)))
      .filter(Boolean)
      .map(tag => ({ tag, group: groupsById.get(tag.group_id) || null }))
      .sort((a, b) => (a.group ? a.group.sort_order : Infinity) - (b.group ? b.group.sort_order : Infinity)
        || a.tag.name.localeCompare(b.tag.name));
    return { ...data, tagsById, groupsById, tagsOfTrade, refreshTags, createTag };
  }, [data, refreshTags, createTag]);

  return <TagsContext.Provider value={value}>{children}</TagsContext.Provider>;
}

export const useTags = () => useContext(TagsContext);
export const tagsApi = api;
