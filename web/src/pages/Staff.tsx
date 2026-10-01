import { useState } from 'react';
import {
  Card, Select, Button, Tag, Space, Statistic, Row, Col, Table, Input, Modal,
  Alert, Badge, Typography, message, Empty, Tooltip,
} from 'antd';
import {
  CloudOutlined, SoundOutlined, ReloadOutlined, WarningOutlined, SwapOutlined,
} from '@ant-design/icons';
import { api, TICKET_TYPE, TRIP_STATUS, TRANSFER_STATUS, waitText } from '../api';
import { useApi } from '../hooks';
import {
  ConfirmPlanModal, StaffMeetModal, timelineModal, dirText,
} from '../components/Transfer';

export default function StaffPage() {
  const { data: overview } = useApi<any>('/overview');
  const [stationId, setStationId] = useState<number>(1);
  const [ticketCode, setTicketCode] = useState('');
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [confirmPlan, setConfirmPlan] = useState<any>(null);
  const [meetPlan, setMeetPlan] = useState<any>(null);
  const [tick, setTick] = useState(0);
  const boardPath = stationId ? `/stations/${stationId}/board` : null;
  const { data: board, loading } = useApi<any>(boardPath, [stationId, tick]);

  const stations = overview?.stations || [];
  const refresh = () => setTick(t => t + 1);

  const enqueue = async () => {
    try {
      await api.post(`/stations/${stationId}/enqueue`, { ticketCode: ticketCode.trim() });
      message.success('扫码入队成功');
      setTicketCode('');
      refresh();
    } catch (e: any) { message.error(e.message); }
  };

  const congestionTag = (c: string) =>
    c === 'overloaded' ? <Tag color="red">拥堵过载</Tag>
    : c === 'busy' ? <Tag color="orange">较繁忙</Tag>
    : <Tag color="green">畅通</Tag>;

  const queueCols = [
    {
      title: '顺位', key: 'order', width: 60,
      render: (_: any, __: any, i: number) => i + 1,
    },
    {
      title: '游客 / 票', key: 'visitor',
      render: (_: any, r: any) => (
        <Space direction="vertical" size={0}>
          <b>{r.ticket?.visitorName}</b>
          <span className="muted">{r.ticket?.code} · {TICKET_TYPE[r.ticket?.type] || ''}</span>
        </Space>
      ),
    },
    {
      title: '人数 / 需求', key: 'party',
      render: (_: any, r: any) => (
        <Space wrap size={4}>
          <b>{r.partySize} 人</b>
          {r.transferPlanId && <Tag color="magenta">误乘换乘交接·免排队</Tag>}
          {r.priority && <Tag color="purple">优先</Tag>}
          {r.ticket?.needWheelchair && <Tag color="geekblue">轮椅</Tag>}
          {r.ticket?.hasStroller && <Tag>婴儿车</Tag>}
          {r.ticket?.hasElder && <Tag>老人</Tag>}
          {r.ticket?.hasChild && <Tag>儿童</Tag>}
        </Space>
      ),
    },
    {
      title: '方向', key: 'dir', width: 80,
      render: (_: any, r: any) =>
        <Tag>{r.expectedDirection === 'forward' ? '上行' : r.expectedDirection === 'backward' ? '下行' : '环线'}</Tag>,
    },
    {
      title: '已等待', key: 'wait', width: 110,
      render: (_: any, r: any) => waitText(r.waitSeconds),
    },
    {
      title: '操作', key: 'op', width: 260,
      render: (_: any, r: any) => (
        <Space wrap>
          {board?.trips?.filter((t: any) => ['boarding', 'running'].includes(t.status)).map((t: any) => (
            <Button key={t.id} size="small" type="primary"
              onClick={async () => {
                try { await api.post(`/queue/${r.id}/board`, { tripId: t.id }); message.success('检票成功'); refresh(); }
                catch (e: any) { message.error(e.message); }
              }}>
              检入 {t.code.split('-')[1]}
            </Button>
          ))}
          <Tooltip title="游客坚持乘反方向车时，强制放行并通知调度接应">
            <Button size="small" danger ghost
              onClick={async () => {
                const t = board?.trips?.find((x: any) => ['boarding', 'running'].includes(x.status));
                if (!t) return message.warning('当前没有可检班次');
                Modal.confirm({
                  title: '确认强制放行反方向乘车？',
                  content: '系统将生成误乘事件并通知调度安排返程衔接',
                  onOk: async () => {
                    await api.post(`/queue/${r.id}/board`, { tripId: t.id, force: true });
                    message.success('已强制放行'); refresh();
                  },
                });
              }}>强制放行</Button>
          </Tooltip>
          <Button size="small"
            onClick={() => Modal.confirm({
              title: '记录优先乘车争议',
              content: <Input.TextArea id="dispute-text" rows={3} placeholder="描述争议经过，如：普通游客质疑老人插队" />,
              onOk: async (node) => {
                const txt = (document.getElementById('dispute-text') as HTMLTextAreaElement)?.value || '老人优先引发争议';
                await api.post(`/queue/${r.id}/dispute`, { detail: txt });
                message.success('争议已上报客服');
              },
            })}>争议上报</Button>
          <Button size="small" type="text" danger onClick={() => Modal.confirm({
            title: '游客离队？', onOk: async () => { await api.post(`/queue/${r.id}/leave`, {}); refresh(); },
          })}>离队</Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap>
        <Select
          style={{ width: 280 }} value={stationId} onChange={setStationId}
          options={stations.map((s: any) => ({
            value: s.id,
            label: `${s.routeName} · ${s.name}${s.isHot ? '🔥' : ''}`,
          }))}
        />
        <Button icon={<ReloadOutlined />} onClick={refresh}>刷新看板</Button>
        <Button icon={<SoundOutlined />} onClick={() => setBroadcastOpen(true)}>站点广播</Button>
        <Button onClick={async () => {
          const v = await Modal.confirm({
            title: `设置「${board?.station?.name}」景点限流（人/小时，0=不限）`,
            content: <Input id="limit-input" defaultValue={board?.flowLimitPerHour || 0} type="number" />,
            onOk: async () => {
              const n = Number((document.getElementById('limit-input') as HTMLInputElement)?.value || 0);
              await api.patch(`/stations/${stationId}`, { flowLimitPerHour: n });
              refresh();
            },
          });
          void v;
        }}>景点限流</Button>
        <span className="muted">平板模式：为站务工作人员展示本站排队、检票、车辆与天气</span>
      </Space>

      {board && (
        <>
          <Row gutter={12}>
            <Col xs={12} md={6}>
              <Card><Statistic title="当前排队" value={board.waitingPeople} suffix="人"
                prefix={congestionTag(board.congestion)} /></Card>
            </Col>
            <Col xs={12} md={6}>
              <Card><Statistic title="优先组人数" value={board.priorityPeople} suffix="人"
                valueStyle={{ color: '#722ed1' }} /></Card>
            </Col>
            <Col xs={12} md={6}>
              <Card><Statistic title="今日已检票" value={board.checkedToday} suffix="组" /></Card>
            </Col>
            <Col xs={12} md={6}>
              <Card>
                <Statistic title="天气"
                  formatter={() => (
                    <Space>
                      <CloudOutlined />
                      <span>{board.weather?.condition} {board.weather?.tempC}℃</span>
                      {board.weather?.warning ? <Tag color="red">{board.weather.warning}</Tag> : <Tag>无预警</Tag>}
                    </Space>
                  )} />
              </Card>
            </Col>
          </Row>

          {board.controls?.length > 0 && (
            <Alert type="warning" showIcon icon={<WarningOutlined />}
              message="道路管制提示"
              description={board.controls.map((c: any) => `${c.segment}：${c.reason}`).join('；')} />
          )}
          {board.flowLimitPerHour > 0 && (
            <Alert type="info" showIcon message={`本站景点限流 ${board.flowLimitPerHour} 人/小时，注意控制放行节奏`} />
          )}

          <TransferAlerts
            transfers={board.transfers || []}
            trips={board.trips || []}
            onConfirm={setConfirmPlan}
            onMeet={setMeetPlan}
            onChanged={refresh}
          />

          <Card title="游客扫码入队" extra={<span className="muted">仅本站票面始发站可入队，系统自动校验方向</span>}>
            <Space style={{ width: '100%' }}>
              <Input style={{ maxWidth: 320 }} placeholder="扫描/输入车票号，如 T20260925-001"
                value={ticketCode} onChange={e => setTicketCode(e.target.value)} onPressEnter={enqueue} />
              <Button type="primary" onClick={enqueue}>扫码排队</Button>
              <span className="muted">提示：东门枢纽队列含种子游客 T20260925-001~004</span>
            </Space>
          </Card>

          <Card
            title={<Space>候乘队列（优先组在前，同组 FIFO）
              <Badge count={board.queue.length} color="#2f6b4f" /></Space>}
            extra={
              <Space>
                <Select style={{ width: 180 }} placeholder="选择班次一键叫号"
                  options={board.trips.filter((t: any) => ['boarding', 'running'].includes(t.status))
                    .map((t: any) => ({ value: t.id, label: `${t.code} 余${t.seatsLeft}座` }))}
                  onChange={async (tid) => {
                    try {
                      const r = await api.post(`/stations/${stationId}/board-next`, { tripId: tid });
                      if (r.ok) message.success(`检票成功：${r.entry.ticketId}，等待 ${waitText(r.waitSeconds)}`);
                      else message.warning(r.reason);
                      refresh();
                    } catch (e: any) { message.error(e.message); }
                  }} />
              </Space>
            }>
            <Table rowKey="id" size="small" loading={loading}
              columns={queueCols} dataSource={board.queue} pagination={false}
              locale={{ emptyText: <Empty description="本站当前无人排队" /> }}
              rowClassName={(r: any) => r.priority ? 'priority-row' : ''} />
          </Card>

          <Card title="途经本站班车（车辆位置 · 座位余量 · 轮椅位）">
            <Table rowKey="id" size="small" pagination={false} dataSource={board.trips}
              columns={[
                { title: '班次', dataIndex: 'code' },
                { title: '状态', dataIndex: 'status', render: (s: string) => <Tag color={TRIP_STATUS[s]?.color}>{TRIP_STATUS[s]?.text}</Tag> },
                { title: '方向', dataIndex: 'direction', render: (d: string) => d === 'forward' ? '上行' : d === 'backward' ? '下行' : '环线' },
                { title: '车辆', key: 'v', render: (_: any, r: any) =>
                  <Space size={4}>{r.vehicle?.code}{r.vehicle?.accessible && <Tag color="cyan">无障碍</Tag>}
                    {r.skippedHere && <Tag color="red">本站被跳过</Tag>}</Space> },
                {
                  title: '座位余量', key: 'seats',
                  render: (_: any, r: any) => (
                    <Space>
                      <div className="bar-wrap" style={{ width: 130 }}>
                        <div className="bar-track"><div className={`bar-fill ${r.seatsLeft <= 3 ? 'red' : ''}`}
                          style={{ width: `${r.seatsTotal ? Math.round((r.seatsSold / r.seatsTotal) * 100) : 0}%` }} /></div>
                      </div>
                      <b style={{ color: r.seatsLeft <= 3 ? '#cf1322' : undefined }}>{r.seatsLeft}</b>/{r.seatsTotal}
                    </Space>
                  ),
                },
                { title: '轮椅位', key: 'wl', render: (_: any, r: any) => `${r.wheelchairLeft} 个` },
                {
                  title: '车辆电量', key: 'bat', width: 120,
                  render: (_: any, r: any) => (
                    <div className="bar-wrap">
                      <div className="bar-track" style={{ width: 70 }}>
                        <div className={`bar-fill ${r.vehicle?.battery < 35 ? 'gold' : ''}`}
                          style={{ width: `${r.vehicle?.battery || 0}%` }} />
                      </div>
                      <span>{r.vehicle?.battery}%</span>
                    </div>
                  ),
                },
                { title: '车辆状态', key: 'vs', render: (_: any, r: any) =>
                  <Tag color={r.vehicle?.status === 'breakdown' ? 'red' : r.vehicle?.status === 'running' ? 'blue' : 'default'}>
                    {({ idle: '待命', running: '在运', charging: '充电中', maintenance: '维保', breakdown: '故障' } as any)[r.vehicle?.status] || r.vehicle?.status}
                  </Tag> },
              ]} />
          </Card>

          <Card title="最近广播">
            {board.broadcasts?.length ? board.broadcasts.map((b: any) => (
              <div key={b.id} style={{ padding: '6px 0', borderBottom: '1px dashed #eee' }}>
                <SoundOutlined /> <Typography.Text strong>{b.stationId === 0 ? '【全线】' : '【本站】'}</Typography.Text>
                {b.content}
                <span className="muted" style={{ marginLeft: 8 }}>{new Date(b.createdAt).toLocaleTimeString('zh-CN')}</span>
              </div>
            )) : <Empty description="暂无广播" />}
          </Card>
        </>
      )}

      <BroadcastModal open={broadcastOpen} stationId={stationId}
        onClose={() => setBroadcastOpen(false)} onDone={() => { setBroadcastOpen(false); refresh(); }} />

      {confirmPlan && (
        <ConfirmPlanModal plan={confirmPlan} byRole="staff"
          connectTrips={(board?.trips || []).filter((t: any) =>
            ['boarding', 'running', 'scheduled'].includes(t.status)
            && (t.direction === confirmPlan.neededDirection || t.direction === 'loop'))}
          onDone={() => { setConfirmPlan(null); refresh(); }} />
      )}
      {meetPlan && <StaffMeetModal plan={meetPlan} onDone={() => { setMeetPlan(null); refresh(); }} />}
    </Space>
  );
}

/** 下一站误乘接应提醒：不重新排队，直接交接换乘 */
function TransferAlerts({ transfers, trips, onConfirm, onMeet, onChanged }: {
  transfers: any[];
  trips: any[];
  onConfirm: (p: any) => void;
  onMeet: (p: any) => void;
  onChanged: () => void;
}) {
  if (!transfers.length) return null;
  return (
    <Card title={<Space><SwapOutlined style={{ color: '#d4380d' }} />误乘反方向 · 本站接应提醒
      <Badge count={transfers.length} color="#cf1322" /></Space>}
      extra={<span className="muted">游客由反方向班车送达本站，禁止要求重新排队，直接优先交接</span>}>
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        {transfers.map(p => {
          const st = TRANSFER_STATUS[p.status];
          return (
            <Alert
              key={p.id}
              type={p.status === 'declined' ? 'error' : 'warning'}
              showIcon
              message={
                <Space wrap>
                  <b>{p.ticket?.visitorName}（{p.ticket?.partySize}人）</b>
                  <Tag color="purple">误乘</Tag>
                  <Tag color={st?.color}>{st?.text}</Tag>
                  <span className="muted">{p.code} · 误乘班 {p.wrongTrip?.code}（{dirText(p.wrongTrip?.direction)}）</span>
                  {p.ticket?.needWheelchair && <Tag color="geekblue">轮椅</Tag>}
                  {p.driverAckAt
                    ? <Tag color="green">司机已知悉</Tag>
                    : <Tag color="orange">司机未确认</Tag>}
                </Space>
              }
              description={
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <div>
                    应在本站下车换乘 <b>{dirText(p.neededDirection)}</b> 方向车前往
                    <b> {p.destStationName}</b>；{p.chosenOption
                      ? `已确认方案：${p.chosenOption.title}`
                      : '方案待确认'}；预计额外等待约 {p.estimatedWaitMinutes} 分钟
                    {p.extraWait && <Tag color="orange" style={{ marginLeft: 8 }}>已产生额外等待 {p.actualWaitMinutes} 分</Tag>}
                  </div>
                  {p.refund && (
                    <div className="muted">关联退票单 {p.refund.code}
                      （{p.refund.status === 'paid' ? '已退款' : '客服处理中'}）</div>
                  )}
                  <Space wrap>
                    {['proposed', 'confirmed', 'declined'].includes(p.status)
                      && p.chosenOption?.kind !== 'refund_guide' && (
                      <Button size="small" type="primary" onClick={() => onConfirm(p)}>
                        {p.status === 'proposed' ? '确认换乘方案'
                          : p.status === 'declined' ? '游客改主意 · 重新安排换乘' : '调整方案'}
                      </Button>
                    )}
                    {['proposed', 'confirmed'].includes(p.status)
                      && !p.staffMetAt
                      && ['confirmed', 'accepted'].includes(p.status)
                      && p.chosenOption?.kind !== 'refund_guide' && (
                      <Button size="small" type="primary" onClick={() => onMeet(p)}>
                        车辆到站 · 已接到游客（免排队交接）
                      </Button>
                    )}
                    {p.staffMetAt && <Tag color="green">本站已于 {new Date(p.staffMetAt).toLocaleTimeString('zh-CN')} 接应</Tag>}
                    {!p.refund && ['proposed', 'confirmed', 'declined'].includes(p.status) && (
                      <Button size="small" danger onClick={async () => {
                        await api.post(`/transfer-plans/${p.id}/request-refund`, {
                          reason: '下一站工作人员协助：游客误乘后要求退票',
                        });
                        message.success('已代为发起退票，客服可见完整行程变化');
                        onChanged();
                      }}>游客要求退票 · 代发起</Button>
                    )}
                    <Button size="small" type="link" onClick={() => timelineModal(p)}>方案时间线</Button>
                  </Space>
                </Space>
              }
            />
          );
        })}
      </Space>
    </Card>
  );
}

function BroadcastModal({ open, stationId, onClose, onDone }:
  { open: boolean; stationId: number; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'station' | 'all'>('station');
  return (
    <Modal open={open} title="站点广播" onCancel={onClose}
      onOk={async () => {
        if (!text.trim()) return message.warning('请输入广播内容');
        await api.post('/broadcasts', { stationId: scope === 'all' ? 0 : stationId, content: text });
        message.success('广播已播出');
        setText(''); onDone();
      }}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select value={scope} onChange={setScope} style={{ width: 200 }}
          options={[{ value: 'station', label: '仅本站' }, { value: 'all', label: '全线广播' }]} />
        <Input.TextArea rows={3} value={text} onChange={e => setText(e.target.value)}
          placeholder="如：下一班上行观光车约 3 分钟后进站，轮椅游客请在优先通道等候" />
      </Space>
    </Modal>
  );
}
