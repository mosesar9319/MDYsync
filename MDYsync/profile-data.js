'use strict';

// Profile data layer: read/write the signed-in user's own `profiles` row,
// upload an avatar to the avatars Storage bucket, and (admin-only) search
// profiles and assign a role_label.
//
// Built on window.DafSyncChabura.core exactly as kuntras-data.js is, for the
// same reason: this is a signed-in-first, cross-page concern -- the
// /profile/ page, the account dropdown, and the Studio admin panel all need
// it -- and duplicating client()/currentUser() would risk the drift
// notes-format.js already exists to avoid.
//
// See supabase/migrations/20260916140000_profile_self_service.sql for the
// full authorization model this mirrors exactly: the owner may change
// display_name/avatar_path only, through a plain .update() (RLS's
// profiles_owner_update policy); role_label is admin-only, through the
// set_profile_role_label RPC, never a direct update -- the
// profiles_guard_update trigger blocks that even for an admin's own row, by
// design (see that migration's own header on why role_label has no RLS
// UPDATE path at all, only the RPC).

(function () {
  const { client, currentUser, describeError } = window.DafSyncChabura.core;

  const AVATAR_BUCKET = 'avatars';
  const DISPLAY_NAME_MAX = 80;

  async function fetchOwnProfile() {
    const user = currentUser();
    if (!user) return null;
    const { data, error } = await client()
      .from('profiles').select('id, display_name, avatar_path, role_label')
      .eq('id', user.id).single();
    if (error) throw error;
    return data;
  }

  async function updateDisplayName(displayName) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to edit your profile.');
    const { error } = await client()
      .from('profiles').update({ display_name: displayName }).eq('id', user.id);
    if (error) throw error;
    // So the account widget and every other on-page use of the cached
    // profile (currentDisplayName, the avatar) reflect this immediately --
    // see refreshProfile's own header in auth.js for why that isn't
    // automatic.
    await window.DafSyncAuth?.refreshProfile?.();
  }

  // Uploads the given image blob as the caller's own avatar, at a FIXED
  // path (own uid + a fixed filename) so a re-upload always overwrites
  // rather than accumulating old files nobody ever deletes --
  // avatars_owner_write's own RLS only allows writing under {uid}/ in the
  // first place, and upsert:true makes this a true in-place replace.
  // publicUrl is cache-busted with a query string on every call, since the
  // underlying object path never changes and browsers would otherwise keep
  // showing a stale cached image after a re-upload.
  async function uploadAvatar(blob, extension) {
    const user = currentUser();
    if (!user) throw new Error('Sign in to set an avatar.');
    const path = `${user.id}/avatar.${extension}`;
    const { error: uploadError } = await client().storage
      .from(AVATAR_BUCKET)
      .upload(path, blob, { upsert: true, contentType: blob.type });
    if (uploadError) throw uploadError;
    const { data } = client().storage.from(AVATAR_BUCKET).getPublicUrl(path);
    const publicUrl = `${data.publicUrl}?v=${Date.now()}`;
    const { error } = await client()
      .from('profiles').update({ avatar_path: publicUrl }).eq('id', user.id);
    if (error) throw error;
    await window.DafSyncAuth?.refreshProfile?.();
    return publicUrl;
  }

  // A public identity by id -- goes through public_profiles, not profiles
  // directly (see that view's own header: no email, no is_admin, readable
  // by anon). Used by /profile/'s own "how you appear publicly" preview,
  // and reusable anywhere else a public profile lookup is needed later.
  async function fetchPublicProfile(id) {
    const { data, error } = await client()
      .from('public_profiles').select('id, display_name, avatar_path, role_label')
      .eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }

  // --- Admin: finding a user to label, and setting the label -------------
  //
  // Reads through profiles_admin_read (this migration's own addition --
  // there was no way for an admin to find a user at all before this: see
  // the migration's header). Searches display_name only, matching every
  // other search in this codebase (fetchPublicKuntrasim, fetchQuotableNotes,
  // ...), all of which filter a single ilike-able column rather than
  // building a multi-column OR that would need escaping user input against
  // PostgREST's own filter syntax.

  async function adminSearchProfiles(search) {
    let query = client().from('profiles').select('id, email, display_name, role_label');
    if (search) query = query.ilike('display_name', `%${search}%`);
    const { data, error } = await query.order('display_name', { ascending: true }).limit(30);
    if (error) throw error;
    return data || [];
  }

  // roleLabel may be null to clear an existing label -- same RPC, no
  // separate "unset" action (matches updateVisibility's own "the value IS
  // the whole action" shape in kuntras-data.js).
  async function adminSetRoleLabel(userId, roleLabel) {
    const { error } = await client().rpc('set_profile_role_label', {
      p_user_id: userId, p_role_label: roleLabel,
    });
    if (error) throw error;
  }

  // Newest-registered accounts, for the Studio "New accounts" panel. Reuses
  // profiles_admin_read (the same policy adminSearchProfiles relies on) --
  // an admin can already select any row/column of profiles, so listing by
  // created_at needs no new policy or RPC.
  async function adminListRecentSignups(limit) {
    const { data, error } = await client()
      .from('profiles').select('id, email, display_name, created_at')
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }

  window.DafSyncProfile = {
    DISPLAY_NAME_MAX,
    fetchOwnProfile,
    updateDisplayName,
    uploadAvatar,
    fetchPublicProfile,
    adminSearchProfiles,
    adminSetRoleLabel,
    adminListRecentSignups,
    describeError,
  };
})();
