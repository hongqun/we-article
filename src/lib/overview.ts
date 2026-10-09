import { articleHeading } from "./project";
import { readAllProjects, retryMemoryOutboxes } from "./storage";
import { memoryStore } from "./style-memory/store";
import { finalArticleEffect } from "./style-memory/effects";
import { listWritingTopics } from "./topics";

// 统计只按“每篇文章的最近一次成稿”取样，避免同一项目反复成稿拉低意见均值。
export async function articleOverview() {
  await retryMemoryOutboxes();
  const projects = await readAllProjects();
  const configuredTopics = (await listWritingTopics()).filter(topic => topic.styleMemory);
  return configuredTopics.map(({ id: topicId, name }) => {
    const store = memoryStore(topicId);
    const view = store.view();
    const eventCounts = store.eventCounts();
    const runCounts = store.runCounts();
    const outbox = projects.flatMap(project => project.memoryOutbox.filter(event => event.topicId === topicId));
    const storedIds = new Set(store.events(outbox.map(event => event.id)).map(event => event.id));
    const unflushed = outbox.filter(event => !storedIds.has(event.id));
    const pendingEvidence = unflushed.filter(event => event.kind === "manual" || event.kind === "feedback").length;
    const topicProjects = projects.filter(project => project.topicId === topicId ||
      project.finalizations.some(item => item.topicId === topicId));
    const finalized = topicProjects.flatMap(project => {
      const record = [...project.finalizations].reverse().find(item => item.status === "completed" && item.topicId === topicId);
      const version = project.articleVersions.find(item => item.id === record?.articleVersionId);
      if (!record) return [];
      const events = [...new Map([...store.projectEvents(project.id),
        ...project.memoryOutbox.filter(event => event.topicId === topicId)]
        .map(event => [event.id, event] as const)).values()];
      // 按实际生成请求关联画像；失败调用、其他阶段调用和未知历史不算正文使用。
      const effect = finalArticleEffect(project, record, events);
      return [{ id: project.id, title: articleHeading(version?.content ?? "") || project.selectedTopic || project.title,
        date: record.createdAt, ...effect, manualEdited: effect.manualSessions > 0 }];
    }).sort((a, b) => a.date.localeCompare(b.date));
    const recent = finalized.slice(-5);
    const previous = finalized.slice(-10, -5);
    const average = (items: typeof finalized) => items.length
      ? Number((items.reduce((sum, item) => sum + item.editCount, 0) / items.length).toFixed(1)) : null;
    const comparable = finalized.filter(item => item.baselineKnown && item.styleUsed !== null);
    const assisted = comparable.filter(item => item.styleUsed === true);
    const unassisted = comparable.filter(item => item.styleUsed === false);
    const changeAverage = (items: typeof finalized) => {
      const values = items.flatMap(item => item.changePercent === null ? [] : [item.changePercent]);
      return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
    };
    const comparisonReady = assisted.length >= 5 && unassisted.length >= 5;
    const trendDetails = view.trends.map(trend => {
      const evidence = store.events(trend.evidence.map(item => item.eventId));
      const samples = finalized.filter(item => item.trendIds.includes(trend.id));
      return { id: trend.id, text: trend.text, stage: trend.stage, scene: trend.scene, status: trend.status,
        supportProjectCount: trend.supportProjectCount ?? 0,
        evidenceCount: trend.evidence.length,
        // 原文仍通过按需接口读取；概览只携带定位证据所需的 ID。
        evidenceIds: trend.evidence.map(item => item.eventId),
        projectCount: new Set(evidence.filter(item => item.kind !== "correction").map(item => item.projectId)).size,
        usedArticles: samples.length, editAverage: average(samples), updatedAt: trend.updatedAt };
    });
    return { topicId, name,
      projectCount: topicProjects.length, finalizedCount: finalized.length,
      evidenceCount: (eventCounts.manual ?? 0) + (eventCounts.feedback ?? 0) + pendingEvidence,
      pendingCount: view.pendingCount + pendingEvidence,
      usageCount: store.usedMemoryCount() + unflushed.filter(event => event.kind === "usage" &&
        Boolean(event.usage?.hadMemory || event.usage?.trendIds.length || event.usage?.exampleIds.length)).length,
      trendCounts: { active: view.trends.filter(item => item.status === "active").length,
        observing: view.trends.filter(item => item.status === "observing").length,
        conflicted: view.trends.filter(item => item.status === "conflicted").length,
        disabled: view.trends.filter(item => item.status === "disabled").length },
      runCounts: { succeeded: runCounts.succeeded ?? 0, failed: runCounts.failed ?? 0 },
      recentAverage: average(recent), previousAverage: average(previous),
      recentCount: recent.length, previousCount: previous.length,
      manualRate: finalized.length ? Math.round(finalized.filter(item => item.manualEdited).length / finalized.length * 100) : null,
      assistedCount: assisted.length, assistedAverage: average(assisted),
      unassistedAverage: average(unassisted), unassistedCount: unassisted.length,
      unknownCount: finalized.length - comparable.length,
      assistedChange: changeAverage(assisted), unassistedChange: changeAverage(unassisted), comparisonReady,
      assessment: !comparisonReady ? "可比较样本不足：使用与未使用记忆两组各需至少 5 篇成稿。" :
        average(assisted)! < average(unassisted)!
          ? "使用记忆组的后续修改较少，是改善线索；题材、长度与写作要求仍可能影响结果。"
          : "目前没有观察到使用记忆组的后续修改减少，需要查看具体偏好和修改实例。",
      latestVersion: view.versions[0]?.id ?? null, lastSuccess: view.lastSuccess,
      trendDetails,
      profileChanges: view.versions.slice(0, 5).map((version, index) => {
        const previous = view.versions[index + 1];
        return { id: version.id, reason: version.reason, date: version.createdAt,
          added: previous ? version.trends.filter(item => !previous.trends.some(old => old.id === item.id)).length : null,
          changed: previous ? version.trends.filter(item => previous.trends.some(old => old.id === item.id &&
            (old.text !== item.text || old.status !== item.status || old.evidence.length !== item.evidence.length))).length : null };
      }),
      articles: finalized.slice(-10).reverse() };
  });
}
