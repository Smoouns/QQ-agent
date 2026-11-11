// Sharing is separate from source visibility: sources and old versions keep their scope.
export const PROFILE_CATEGORIES = ['nickname', 'interest', 'communication'];
const group = (key) => /^group:\d+$/.test(key);
const sensitiveOrSituational = /私聊|保密|秘密|别告诉|不要告诉|仅限|只在|本群|这个群|今天|昨天|明天|今晚|这次|最近|暂时|目前|刚刚|周[一二三四五六日天]|星期|\d{4}[-年/]|住址|地址|身份证|电话|手机号|密码|邮箱|病史|诊断|抑郁|疾病|收入|工资|存款|负债|银行卡|公司|学校|政治|宗教|性取向|性癖/;

export function profileSharingIssue(r, { requireSources = false } = {}) {
  if (!PROFILE_CATEGORIES.includes(r.profileCategory)) return '未标记稳定个人资料';
  if (r.profileSharingDisabled) return '管理员已关闭此条目的个人资料共享';
  if (r.subjectIds?.length !== 1 || !/^qq:[1-9]\d{0,14}$/.test(r.subjectIds[0])) return '个人资料必须只属于一个真实 QQ';
  const kinds = { nickname: ['fact', 'interaction'], interest: ['preference'], communication: ['interaction', 'preference'] };
  if (!kinds[r.profileCategory].includes(r.kind)) return '类型不符合稳定个人资料类别';
  if (r.status !== 'active' || r.expiresAt || r.eventId || r.title) return '事件、临时状态或带期限的记录不共享';
  if (!r.content || r.content.length > 200 || sensitiveOrSituational.test(r.content)) return '内容可能包含敏感信息或具体情境，保留来源范围';
  if (r.visibility?.type !== 'chats' || !r.visibility.chatKeys?.length || !r.visibility.chatKeys.every(group)) return '只从群聊范围建立共享个人资料';
  const versions = [r, ...(r.history || [])];
  if (versions.some((v) => v.visibility?.chatKeys?.some((k) => k.startsWith('private:')) ||
    v.legacySource?.chatKey?.startsWith('private:') || (v.sources || []).some((s) => !group(s.chatKey)))) return '记录含私聊或未知范围来源';
  if (!['explicit', 'admin'].includes(r.evidence)) return '需要本人明确表达或管理员确认';
  const sources = r.sources || [];
  if (sources.some((s) => /私聊|保密|秘密|别告诉|不要告诉|别外传|仅限|只在|本群/.test(s.text || ''))) return '来源含保密或范围限定要求';
  if ((requireSources || r.evidence !== 'admin') && !sources.length) return '缺少本人原始证据';
  const userId = r.subjectIds[0].slice(3);
  if (sources.some((s) => !group(s.chatKey) || String(s.senderId) !== userId)) return '不能将他人转述或机器人发言共享为本人资料';
  return '';
}

export const sharedPersonalProfile = (r) => !!r?.profileCategory && !profileSharingIssue(r);

// Migration deliberately recognizes a small, standalone vocabulary. Uncertain legacy
// prose is left scoped for human review; no new model calls or invented evidence.
export function legacyProfileCategory(r) {
  if (r.profileCategory !== undefined || r.profileSharingDisabled || r.pinned || r.evidence !== 'explicit') return '';
  const userId = r.subjectIds?.[0]?.replace(/^qq:/, '') || '';
  const normalize = (text) => String(text || '').trim().replace(/[。！!]+$/, '').replace(/^(?:我|本人)\s*/, '')
    .replace(new RegExp(`^(?:QQ[:：]?\\s*)?${userId}\\s*`), '').trim();
  const content = normalize(r.content);
  let category = '';
  if (/^(?:喜欢|爱好)(?:策略游戏|合作游戏|单机游戏|电子游戏|桌游|围棋|象棋|阅读|读书|科幻小说|推理小说|古典音乐|摇滚乐|爵士乐|音乐|绘画|摄影|编程|跑步|游泳|篮球|足球|羽毛球|乒乓球|咖啡|茶)$/.test(content)) category = 'interest';
  if (/^(?:喜欢|希望|偏好)(?:简短回答|详细回答|直接回答|用中文交流|用中文回答|用英文交流|用英文回答)$/.test(content)) category = 'communication';
  if (/^(?:叫我|称呼我)[\p{Script=Han}A-Za-z_]{1,12}$/u.test(content)) category = 'nickname';
  if (!category || profileSharingIssue({ ...r, profileCategory: category }, { requireSources: true })) return '';
  if (!(r.sources || []).some((s) => normalize(s.text) === content)) return '';
  return category;
}
