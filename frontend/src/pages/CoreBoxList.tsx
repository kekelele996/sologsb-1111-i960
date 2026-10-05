import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Col,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { ImportOutlined, RollbackOutlined, FileSearchOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import BoxGrid from '../components/common/BoxGrid';
import DepthRangeInput from '../components/common/DepthRangeInput';
import EmptyPanel from '../components/common/EmptyPanel';
import { useHoleStore } from '../stores/holeStore';
import { useRunStore } from '../stores/runStore';
import { useBoxStore } from '../stores/boxStore';
import { SHELF_POSITIONS, type CoreBox, type BoxContinuity } from '../types/core-box';
import type { HandoverIssueKind, HandoverItem, HandoverReconcile } from '../types/handover';
import { boxCapacityOk, checkBoxContinuity, validateRange } from '../utils/recovery';
import { parseHandoverText, reconcileHandover } from '../utils/handover';

const { Title, Paragraph, Text } = Typography;

interface BoxFormValues {
  boxNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  slots: number;
  slotLength: number;
  boxedAt: Dayjs;
  shelfPos?: string;
  operator: string;
  damagedText?: string;
  remark?: string;
}

function parseSlots(text: string | undefined): number[] {
  if (!text) return [];
  return Array.from(
    new Set(
      text
        .split(/[,，\s]+/)
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0),
    ),
  ).sort((a, b) => a - b);
}

/** 对账结论的展示样式 */
const ISSUE_META: Record<HandoverIssueKind, { label: string; color: string }> = {
  update: { label: '可入架', color: 'green' },
  consistent: { label: '已一致', color: 'default' },
  boxMissing: { label: '箱号对不上', color: 'red' },
  shelfDuplicate: { label: '架位重复', color: 'orange' },
  rackedAtEmpty: { label: '入架时间空', color: 'orange' },
  duplicateBoxNo: { label: '箱号重复', color: 'orange' },
  malformed: { label: '行残缺', color: 'red' },
};

const EXAMPLE_HANDOVER = `箱号\t货架位\t入架时间
X-2402-01\tA 区 1 架\t2026-09-20 09:30
X-2402-02\tA 区 2 架\t2026-09-20 09:35
X-2402-03\tA 区 2 架\t2026-09-20 09:40
X-2403-01\tB 区 1 架\t2026-09-18 14:00
X-2403-02\tB 区 2 架\t2026-09-18 14:10
X-2404-01\tB 区 2 架\t2026-09-19 10:00
X-2404-02\tC 区 1 架\t2026-09-19 10:20
X-2401-01\tC 区 1 架
X-2404-01\tC 区 2 架\t2026-09-19 11:00
一箱岩芯待补标签\t2026-09-19 11:10`;

/** 库管员移交单对账弹窗：粘贴 → 预览差异 → 导入（仅写入对账通过的条目） */
function HandoverModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const boxes = useBoxStore((s) => s.boxes);
  const applyHandover = useBoxStore((s) => s.applyHandover);

  const [text, setText] = useState('');
  const [reconcile, setReconcile] = useState<HandoverReconcile | null>(null);
  const [parsedText, setParsedText] = useState('');
  const [importing, setImporting] = useState(false);

  const reset = () => {
    setText('');
    setReconcile(null);
    setParsedText('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handlePreview = () => {
    try {
      const rows = parseHandoverText(text);
      setReconcile(reconcileHandover(rows, boxes));
      setParsedText(text);
    } catch (error) {
      message.error((error as Error).message);
      setReconcile(null);
    }
  };

  const handleImport = async () => {
    if (!reconcile) return;
    if (reconcile.updates.length === 0) {
      message.warning('没有可写入的条目，无需导入');
      return;
    }
    setImporting(true);
    try {
      const batch = await applyHandover(parsedText, reconcile.items);
      message.success(`已按移交单入架 ${batch.updateCount} 箱；差异 ${batch.issueCount} 行照本台保留。可在岩芯箱页整批撤回。`);
      handleClose();
    } catch (error) {
      message.error(`导入失败：${(error as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const countOf = (kind: HandoverIssueKind) => reconcile?.items.filter((item) => item.kind === kind).length ?? 0;

  const previewColumns: TableColumnsType<HandoverItem> = [
    { title: '行', dataIndex: 'lineNo', width: 50, align: 'right' },
    { title: '箱号', dataIndex: 'boxNo', width: 130, render: (v: string) => <Text strong>{v || '—'}</Text> },
    { title: '货架位', dataIndex: 'shelfPos', width: 110, render: (v: string) => v || <Text type="warning">（空）</Text> },
    {
      title: '入架时间',
      width: 160,
      render: (_, row) =>
        row.rackedAt ? (
          dayjs(row.rackedAt).format('YYYY-MM-DD HH:mm')
        ) : (
          <Text type="warning">{row.rackedAtText || '（空）'}</Text>
        ),
    },
    {
      title: '结论',
      width: 100,
      render: (_, row) => {
        const meta = ISSUE_META[row.kind];
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    { title: '对账说明 / 差异', dataIndex: 'detail' },
  ];

  return (
    <Modal
      open={open}
      title="库管员移交单对账"
      onCancel={handleClose}
      width={920}
      destroyOnClose
      footer={
        <Space>
          <Button
            type="link"
            onClick={() => {
              setText(EXAMPLE_HANDOVER);
              setReconcile(null);
            }}
          >
            填入示例移交单
          </Button>
          <Button onClick={handleClose}>关闭</Button>
          <Button icon={<FileSearchOutlined />} onClick={handlePreview} disabled={!text.trim()}>
            按箱号核对
          </Button>
          <Button type="primary" icon={<ImportOutlined />} loading={importing} disabled={!reconcile || reconcile.updates.length === 0} onClick={handleImport}>
            导入 {reconcile ? reconcile.updates.length : 0} 箱并标记已入架
          </Button>
        </Space>
      }
    >
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        把库管员发来的移交单整段贴进来（支持表头识别，列序不限；TSV/CSV/空格分隔均可）。按箱号核对货架位与入架时间：箱号对不上、货架位重复、入架时间空着的
        <Text strong> 照本台保留</Text>，只在下面列差异。
      </Paragraph>
      <Input.TextArea
        rows={7}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (parsedText !== e.target.value) setReconcile(null);
        }}
        placeholder={'箱号\t货架位\t入架时间\nX-2402-01\tA 区 1 架\t2026-09-20 09:30'}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />

      {reconcile ? (
        <div style={{ marginTop: 12 }}>
          <Alert
            type={reconcile.updates.length > 0 ? 'success' : 'warning'}
            showIcon
            style={{ marginBottom: 10 }}
            message={
              <Space size={[8, 4]} wrap>
                <Text>
                  可入架 <Text strong>{reconcile.updates.length}</Text> 箱
                </Text>
                {countOf('consistent') > 0 ? <Tag>已一致 {countOf('consistent')}</Tag> : null}
                {countOf('boxMissing') > 0 ? <Tag color="red">箱号对不上 {countOf('boxMissing')}</Tag> : null}
                {countOf('shelfDuplicate') > 0 ? <Tag color="orange">架位重复 {countOf('shelfDuplicate')}</Tag> : null}
                {countOf('rackedAtEmpty') > 0 ? <Tag color="orange">入架时间空 {countOf('rackedAtEmpty')}</Tag> : null}
                {countOf('duplicateBoxNo') > 0 ? <Tag color="orange">箱号重复 {countOf('duplicateBoxNo')}</Tag> : null}
                {countOf('malformed') > 0 ? <Tag color="red">行残缺 {countOf('malformed')}</Tag> : null}
                <Text type="secondary">本台另有 {reconcile.untouchedCount} 箱未提及，保持原样</Text>
              </Space>
            }
          />
          <Table
            rowKey={(row) => `${row.lineNo}-${row.boxNo}`}
            size="small"
            columns={previewColumns}
            dataSource={reconcile.items}
            pagination={{ pageSize: 8 }}
            scroll={{ x: 860 }}
            rowClassName={(row) => (row.kind === 'update' ? '' : 'handover-skip-row')}
          />
        </div>
      ) : null}
    </Modal>
  );
}

/** 岩芯箱编目与格位分配：校验深度连续性 */
export default function CoreBoxList() {
  const { message } = AntApp.useApp();
  const holes = useHoleStore((s) => s.holes);
  const currentHoleId = useHoleStore((s) => s.currentHoleId);
  const setCurrentHole = useHoleStore((s) => s.setCurrentHole);
  const runs = useRunStore((s) => s.runs);
  const boxes = useBoxStore((s) => s.boxes);
  const addBox = useBoxStore((s) => s.addBox);
  const updateBox = useBoxStore((s) => s.updateBox);
  const removeBox = useBoxStore((s) => s.removeBox);
  const toggleDamagedSlot = useBoxStore((s) => s.toggleDamagedSlot);
  const lastBatch = useBoxStore((s) => s.lastBatch);
  const revertLastHandover = useBoxStore((s) => s.revertLastHandover);

  const [form] = Form.useForm<BoxFormValues>();
  const [open, setOpen] = useState(false);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [editing, setEditing] = useState<CoreBox | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState('');
  /** 深度区间以本地 state 为唯一数据源（Form.useWatch 在弹窗挂载前可能读不到值） */
  const [range, setRange] = useState<{ from: number; to: number }>({ from: 0, to: 0 });

  const holeOptions = holes.map((hole) => ({ label: `${hole.holeNo} · ${hole.rigNo}`, value: hole.id }));
  const activeHoleId = currentHoleId || holes[0]?.id || '';
  const holeBoxes = useMemo(() => boxes.filter((b) => b.holeId === activeHoleId), [boxes, activeHoleId]);
  const selectedBox = useMemo(
    () => holeBoxes.find((b) => b.id === selectedBoxId) ?? holeBoxes[0],
    [holeBoxes, selectedBoxId],
  );

  /** 缺货架位（未入架且架位空）：全局统计，提示编录员补齐预排 */
  const missingShelfBoxes = useMemo(() => boxes.filter((b) => b.rackStatus !== 'racked' && !b.shelfPos.trim()), [boxes]);
  const holeNoOf = (id: string) => holes.find((h) => h.id === id)?.holeNo ?? '';

  const continuityOf = (box: CoreBox): BoxContinuity => checkBoxContinuity(box, runs);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    const lastBox = holeBoxes.reduce<CoreBox | undefined>((acc, box) => (!acc || box.toDepth > acc.toDepth ? box : acc), undefined);
    const from = lastBox ? lastBox.toDepth : 0;
    const to = Number((from + 25).toFixed(2));
    setRange({ from, to });
    form.setFieldsValue({
      boxNo: `X-${holes.find((h) => h.id === activeHoleId)?.holeNo.replace(/^ZK-/, '') ?? '0000'}-${String(holeBoxes.length + 1).padStart(2, '0')}`,
      holeId: activeHoleId,
      fromDepth: from,
      toDepth: to,
      slots: 10,
      slotLength: 2.5,
      boxedAt: dayjs(),
      shelfPos: SHELF_POSITIONS[0],
      operator: '高振华',
      damagedText: '',
    } as unknown as BoxFormValues);
    setOpen(true);
  };

  const openEdit = (record: CoreBox) => {
    setEditing(record);
    setRange({ from: record.fromDepth, to: record.toDepth });
    form.setFieldsValue({
      boxNo: record.boxNo,
      holeId: record.holeId,
      fromDepth: record.fromDepth,
      toDepth: record.toDepth,
      slots: record.slots,
      slotLength: record.slotLength,
      boxedAt: dayjs(record.boxedAt),
      shelfPos: record.shelfPos || undefined,
      operator: record.operator,
      damagedText: record.damagedSlots.join(','),
      remark: record.remark,
    } as unknown as BoxFormValues);
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    const rangeError = validateRange(range.from, range.to);
    if (rangeError) {
      message.error(rangeError);
      return;
    }
    const payload = {
      boxNo: values.boxNo,
      holeId: values.holeId,
      fromDepth: range.from,
      toDepth: range.to,
      slots: Number(values.slots) || 0,
      slotLength: Number(values.slotLength) || 0,
      boxedAt: values.boxedAt.toISOString(),
      shelfPos: values.shelfPos?.trim() ?? '',
      operator: values.operator,
      damagedSlots: parseSlots(values.damagedText).filter((slot) => slot <= (Number(values.slots) || 0)),
      remark: values.remark,
    };
    const draft: CoreBox = { id: editing?.id ?? 'draft', rackStatus: editing?.rackStatus ?? 'unracked', ...payload };
    if (!boxCapacityOk(draft)) {
      message.error('格数 × 每格长度小于区间长度，格位容量不足');
      return;
    }
    const continuity = checkBoxContinuity(draft, runs);
    if (editing) {
      await updateBox(editing.id, payload);
      message.success(`已更新箱 ${payload.boxNo}`);
    } else {
      const created = await addBox(payload);
      setSelectedBoxId(created.id);
      message.success(`已装箱 ${payload.boxNo}`);
    }
    if (!payload.shelfPos) {
      message.warning('该箱未排货架位，请在入架前补齐');
    }
    if (!continuity.covered) {
      message.warning(continuity.message);
    }
    setOpen(false);
  };

  const handleRevert = async () => {
    if (!lastBatch) return;
    const batch = await revertLastHandover();
    if (batch) message.success(`已撤回导入，${batch.snapshots.length} 个箱已按快照还原，可重新对账导入`);
  };

  const columns: TableColumnsType<CoreBox> = [
    { title: '箱号', dataIndex: 'boxNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
    { title: '深度区间(m)', width: 120, render: (_, row) => `${row.fromDepth}~${row.toDepth}` },
    {
      title: '库架位',
      dataIndex: 'shelfPos',
      width: 110,
      render: (v: string, row) => (v ? v : <MissingShelfTag racked={row.rackStatus === 'racked'} />),
    },
    {
      title: '入架状态',
      dataIndex: 'rackStatus',
      width: 100,
      render: (_, row) =>
        row.rackStatus === 'racked' ? <Tag color="green">已入架</Tag> : <Tag>未入架</Tag>,
    },
    {
      title: '入架时间',
      dataIndex: 'rackedAt',
      width: 140,
      render: (v?: string) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : <Text type="secondary">—</Text>),
    },
    { title: '格数', dataIndex: 'slots', width: 60, align: 'right' },
    { title: '装箱日期', dataIndex: 'boxedAt', width: 100, render: (v: string) => dayjs(v).format('YYYY-MM-DD') },
    { title: '装箱人', dataIndex: 'operator', width: 90 },
    {
      title: '破损格',
      width: 90,
      render: (_, row) => (row.damagedSlots.length ? <Tag color="red">{row.damagedSlots.join(',')}</Tag> : <Tag color="green">无</Tag>),
    },
    {
      title: '深度连续性校验',
      width: 300,
      render: (_, row) => {
        const continuity = continuityOf(row);
        return continuity.covered ? <Text type="success">{continuity.message}</Text> : <Text type="danger">{continuity.message}</Text>;
      },
    },
    {
      title: '操作',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => setSelectedBoxId(record.id)}>
            查看格位
          </Button>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm title={`确认删除岩芯箱 ${record.boxNo}？`} onConfirm={() => removeBox(record.id).then(() => message.success('已删除'))}>
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const formHoleId = Form.useWatch('holeId', form) ?? activeHoleId;

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        岩芯箱编目与格位分配
      </Title>
      <Paragraph type="secondary">
        编录台账回次进尺与岩芯箱，库管员按箱号移交货架位与入架时间。贴入移交单即可对账：箱号对不上、架位重复、入架时间空的照本台保留并列出差异；一次导入可整体撤回重来。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <span style={{ color: '#6b7a86' }}>当前钻孔</span>
        <Select style={{ width: 200 }} value={activeHoleId} onChange={setCurrentHole} options={holeOptions} placeholder="选择钻孔" />
        <Button type="primary" onClick={openCreate} disabled={!activeHoleId}>
          新建岩芯箱
        </Button>
        <Button icon={<ImportOutlined />} onClick={() => setHandoverOpen(true)}>
          移交单对账
        </Button>
        {lastBatch ? (
          <Popconfirm
            title="整批撤回上次移交单导入？"
            description={`${lastBatch.updateCount} 个箱将还原到导入前状态`}
            okText="整批撤回"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={handleRevert}
          >
            <Button icon={<RollbackOutlined />} danger>
              撤回上次导入（{dayjs(lastBatch.importedAt).format('MM-DD HH:mm')} · {lastBatch.updateCount} 箱）
            </Button>
          </Popconfirm>
        ) : null}
      </Space>

      {missingShelfBoxes.length > 0 ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          message={`有 ${missingShelfBoxes.length} 个未入架箱缺货架位，请补齐预排架位`}
          description={
            <Space size={[4, 4]} wrap>
              {missingShelfBoxes.map((box) => (
                <Tag key={box.id} color="orange">
                  {holeNoOf(box.holeId)} · {box.boxNo}
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      {lastBatch ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="info"
          showIcon
          message={`最近一次移交单导入：${dayjs(lastBatch.importedAt).format('YYYY-MM-DD HH:mm')}，入架 ${lastBatch.updateCount} 箱，差异 ${lastBatch.issueCount} 行照本台保留`}
          description={
            <Space size={[4, 4]} wrap>
              {lastBatch.appliedBoxNos.map((boxNo) => (
                <Tag key={boxNo} color="green">
                  {boxNo}
                </Tag>
              ))}
            </Space>
          }
        />
      ) : null}

      {holeBoxes.length === 0 ? (
        <EmptyPanel description="该孔暂无岩芯箱记录" actionText="新建岩芯箱" onAction={openCreate} />
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24}>
            <Card
              size="small"
              title="格位网格（点击切换破损标记）"
              extra={
                <Select
                  style={{ width: 200 }}
                  value={selectedBox?.id}
                  onChange={setSelectedBoxId}
                  options={holeBoxes.map((box) => ({ label: `${box.boxNo}（${box.fromDepth}~${box.toDepth}m）`, value: box.id }))}
                />
              }
            >
              {selectedBox ? (
                <>
                  <Descriptions size="small" column={4} style={{ marginBottom: 6 }}>
                    <Descriptions.Item label="库架位">
                      {selectedBox.shelfPos || <Text type="warning">缺架位，待补</Text>}
                    </Descriptions.Item>
                    <Descriptions.Item label="入架状态">
                      {selectedBox.rackStatus === 'racked' ? <Tag color="green">已入架</Tag> : <Tag>未入架</Tag>}
                    </Descriptions.Item>
                    <Descriptions.Item label="入架时间">
                      {selectedBox.rackedAt ? dayjs(selectedBox.rackedAt).format('YYYY-MM-DD HH:mm') : '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="装箱人">{selectedBox.operator}</Descriptions.Item>
                  </Descriptions>
                  <BoxGrid box={selectedBox} runs={runs} onToggleDamaged={(slot) => toggleDamagedSlot(selectedBox.id, slot)} />
                  <Alert
                    style={{ marginTop: 10 }}
                    type={continuityOf(selectedBox).covered ? 'success' : 'warning'}
                    showIcon
                    message={continuityOf(selectedBox).message}
                  />
                </>
              ) : null}
            </Card>
          </Col>
          <Col xs={24}>
            <Card size="small" title="岩芯箱台账">
              <Table rowKey="id" size="small" columns={columns} dataSource={holeBoxes} pagination={{ pageSize: 6 }} scroll={{ x: 1500 }} />
            </Card>
          </Col>
        </Row>
      )}

      <Modal open={open} title={editing ? `编辑岩芯箱 · ${editing.boxNo}` : '新建岩芯箱'} onCancel={() => setOpen(false)} onOk={submit} okText="保存" cancelText="取消" width={720}>
        <Form form={form} layout="vertical">
          {editing && (editing.rackStatus === 'racked' || !editing.shelfPos) ? (
            <Alert
              style={{ marginBottom: 12 }}
              type={editing.rackStatus === 'racked' ? 'info' : 'warning'}
              showIcon
              message={
                editing.rackStatus === 'racked'
                  ? `该箱已按库管移交单入架（${editing.shelfPos}${editing.rackedAt ? ` · ${dayjs(editing.rackedAt).format('YYYY-MM-DD HH:mm')}` : ''}），改架位后建议重新对账`
                  : '该箱缺货架位，请先补齐预排架位，再贴移交单对账入架'
              }
            />
          ) : null}
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="boxNo" label="箱号" rules={[{ required: true, message: '请输入箱号' }]}>
              <Input style={{ width: 180 }} maxLength={24} placeholder="如：X-2401-02" />
            </Form.Item>
            <Form.Item name="holeId" label="钻孔" rules={[{ required: true, message: '请选择钻孔' }]}>
              <Select style={{ width: 200 }} options={holeOptions} />
            </Form.Item>
            <Form.Item name="shelfPos" label="库架位（可留空，入架前补齐）">
              <AutoComplete
                style={{ width: 180 }}
                allowClear
                options={SHELF_POSITIONS.map((v) => ({ label: v, value: v }))}
                placeholder="选择或输入架位"
                filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
              />
            </Form.Item>
          </Space>

          <Form.Item label="深度区间" required>
            <DepthRangeInput
              fromDepth={range.from}
              toDepth={range.to}
              referenceRuns={runs.filter((run) => run.holeId === formHoleId)}
              maxDepth={holes.find((h) => h.id === formHoleId)?.designDepth}
              onChange={(patch) => {
                setRange((prev) => ({ ...prev, ...patch }));
                form.setFieldsValue(patch as unknown as BoxFormValues);
              }}
            />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="slots" label="格数" rules={[{ required: true, message: '请输入格数' }]}>
              <InputNumber min={1} max={30} style={{ width: 140 }} placeholder="格数" />
            </Form.Item>
            <Form.Item name="slotLength" label="每格长度(m)" rules={[{ required: true, message: '请输入每格长度' }]}>
              <InputNumber min={0.5} step={0.5} style={{ width: 160 }} placeholder="每格长度" />
            </Form.Item>
            <Form.Item name="boxedAt" label="装箱日期" rules={[{ required: true, message: '请选择装箱日期' }]}>
              <DatePicker style={{ width: 170 }} />
            </Form.Item>
            <Form.Item name="operator" label="装箱人" rules={[{ required: true, message: '请输入装箱人' }]}>
              <Input style={{ width: 140 }} maxLength={16} placeholder="装箱人" />
            </Form.Item>
          </Space>

          <Form.Item name="damagedText" label="破损格序号（逗号分隔，留空表示无破损）">
            <Input placeholder="如：4,7" maxLength={40} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={60} placeholder="岩芯缺失情况等" />
          </Form.Item>
        </Form>
      </Modal>

      <HandoverModal open={handoverOpen} onClose={() => setHandoverOpen(false)} />
    </div>
  );
}

/** 表格里缺架位的提示标记 */
function MissingShelfTag({ racked }: { racked: boolean }) {
  if (racked) return <Text type="warning">缺架位</Text>;
  return <Tag color="orange">缺架位 · 待补</Tag>;
}
