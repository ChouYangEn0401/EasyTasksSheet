import { describe, expect, it } from 'vitest';
import {
  buildProfilePatch,
  canSubmitPassword,
  canSubmitProfile,
  passwordStrength,
  profileChanges,
  roleLabel,
  validateDisplayName,
  validatePasswordForm,
  validateProfile,
  validateUsername,
  type Profile,
} from './model.ts';

const profile: Profile = {
  id: 1,
  username: 'alice',
  displayName: '愛麗絲',
  role: 'member',
  createdAt: 1,
  lastLoginAt: null,
};
const draft = (over: Partial<{ displayName: string; username: string; currentPassword: string }> = {}) => ({
  displayName: profile.displayName,
  username: profile.username,
  currentPassword: '',
  ...over,
});

describe('顯示名稱與帳號', () => {
  it('顯示名稱不可為空白、最多 100 字', () => {
    expect(validateDisplayName('  ')).toBe('請輸入顯示名稱');
    expect(validateDisplayName('a'.repeat(101))).toContain('100');
    expect(validateDisplayName(' 小明 ')).toBeUndefined();
  });
  it('帳號格式同成員管理（trim、轉小寫）', () => {
    expect(validateUsername('')).toBe('請輸入帳號');
    expect(validateUsername('ab')).toContain('3–32');
    expect(validateUsername('bad name')).toContain('3–32');
    expect(validateUsername('  New.Name-1 ')).toBeUndefined();
  });
});

describe('個人資料變更', () => {
  it('未變更時不可送出；大小寫與空白差異視為未變更帳號', () => {
    expect(canSubmitProfile(draft(), profile)).toBe(false);
    expect(profileChanges(draft({ username: ' ALICE ' }), profile).username).toBe(false);
  });
  it('只改顯示名稱不需要密碼，且 patch 只含該欄位', () => {
    const d = draft({ displayName: ' 新名字 ' });
    expect(canSubmitProfile(d, profile)).toBe(true);
    expect(buildProfilePatch(d, profile)).toEqual({ displayName: '新名字' });
  });
  it('改帳號需目前密碼；patch 帶正規化帳號與密碼', () => {
    const d = draft({ username: ' Bob.Lee ' });
    expect(canSubmitProfile(d, profile)).toBe(false);
    const withPw = { ...d, currentPassword: 'secret-pass' };
    expect(canSubmitProfile(withPw, profile)).toBe(true);
    expect(buildProfilePatch(withPw, profile)).toEqual({
      username: 'bob.lee',
      currentPassword: 'secret-pass',
    });
  });
  it('格式錯誤標在欄位並擋住送出', () => {
    expect(validateProfile(draft({ username: 'x!' }), profile).username).toContain('3–32');
    expect(validateProfile(draft({ displayName: '' }), profile).displayName).toBe('請輸入顯示名稱');
    expect(canSubmitProfile(draft({ username: 'x!', currentPassword: 'p' }), profile)).toBe(false);
  });
});

describe('變更密碼', () => {
  it('新密碼至少 8 字、不可為 password、不可同目前密碼', () => {
    expect(validatePasswordForm({ current: 'old-pass-1', next: 'short', confirm: '' }).next).toContain('8');
    expect(validatePasswordForm({ current: 'old-pass-1', next: 'password', confirm: '' }).next).toBe(
      '不可使用預設密碼',
    );
    expect(validatePasswordForm({ current: 'old-pass-1', next: 'old-pass-1', confirm: '' }).next).toContain(
      '相同',
    );
  });
  it('確認不一致時報錯，且須全部通過才可送出', () => {
    const d = { current: 'old-pass-1', next: 'new-pass-123', confirm: 'new-pass-124' };
    expect(validatePasswordForm(d).confirm).toBe('兩次輸入的新密碼不一致');
    expect(canSubmitPassword(d)).toBe(false);
    expect(canSubmitPassword({ ...d, confirm: d.next })).toBe(true);
    expect(canSubmitPassword({ ...d, current: '', confirm: d.next })).toBe(false);
  });
  it('強度提示', () => {
    expect(passwordStrength('').level).toBe(0);
    expect(passwordStrength('abc').level).toBe(1);
    expect(passwordStrength('abcdefgh').level).toBe(1);
    expect(passwordStrength('abcdef12ab').level).toBe(2);
    expect(passwordStrength('Abcdef123456!').level).toBe(3);
  });
});

describe('角色名稱', () => {
  it('已知角色轉中文，未知顯示原值', () => {
    expect(roleLabel('root')).toBe('超級管理員');
    expect(roleLabel('manager')).toBe('管理者');
    expect(roleLabel('user')).toBe('成員');
    expect(roleLabel('weird')).toBe('weird');
  });
});
