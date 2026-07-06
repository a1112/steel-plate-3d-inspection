#include <QApplication>
#include <QAbstractItemView>
#include <QBrush>
#include <QBuffer>
#include <QCheckBox>
#include <QComboBox>
#include <QDateTime>
#include <QDesktopServices>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QDoubleSpinBox>
#include <QColor>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QGridLayout>
#include <QGroupBox>
#include <QHeaderView>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QMainWindow>
#include <QMessageBox>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPlainTextEdit>
#include <QPixmap>
#include <QPushButton>
#include <QSizePolicy>
#include <QSpinBox>
#include <QSplitter>
#include <QStandardPaths>
#include <QStackedWidget>
#include <QStringList>
#include <QRegularExpression>
#include <QTableWidget>
#include <QTableWidgetItem>
#include <QTabWidget>
#include <QSyntaxHighlighter>
#include <QTextCharFormat>
#include <QTextDocument>
#include <QTimer>
#include <QUrl>
#include <QVBoxLayout>
#include <QWidget>

#include <algorithm>
#include <cstdlib>
#include <functional>
#include <map>
#include <string>
#include <thread>
#include <vector>

#include "capture_service_app.h"

namespace {

class JsonHighlighter final : public QSyntaxHighlighter {
 public:
  explicit JsonHighlighter(QTextDocument* parent) : QSyntaxHighlighter(parent) {
    key_format_.setForeground(QColor("#7dd3fc"));
    string_format_.setForeground(QColor("#bbf7d0"));
    number_format_.setForeground(QColor("#fde68a"));
    literal_format_.setForeground(QColor("#fca5a5"));
  }

 protected:
  void highlightBlock(const QString& text) override {
    apply("\\\"(?:\\\\.|[^\\\"\\\\])*\\\"\\s*:", key_format_, text);
    apply(":\\s*\\\"(?:\\\\.|[^\\\"\\\\])*\\\"", string_format_, text);
    apply("\\b-?(?:0|[1-9]\\d*)(?:\\.\\d+)?\\b", number_format_, text);
    apply("\\b(?:true|false|null)\\b", literal_format_, text);
  }

 private:
  void apply(const QString& pattern, const QTextCharFormat& format, const QString& text) {
    const QRegularExpression expression(pattern);
    QRegularExpressionMatchIterator matches = expression.globalMatch(text);
    while (matches.hasNext()) {
      const QRegularExpressionMatch match = matches.next();
      setFormat(static_cast<int>(match.capturedStart()), static_cast<int>(match.capturedLength()), format);
    }
  }

  QTextCharFormat key_format_;
  QTextCharFormat string_format_;
  QTextCharFormat number_format_;
  QTextCharFormat literal_format_;
};

QString zh(const char* text) {
  return QString::fromUtf8(text);
}

int capture_port() {
  const char* value = std::getenv("CAPTURE_SERVICE_PORT");
  if (!value || !*value) {
    return 4317;
  }
  try {
    return std::stoi(value);
  } catch (...) {
    return 4317;
  }
}

QString api_origin(int port) {
  return QString("http://127.0.0.1:%1").arg(port);
}

QString encoded(const QString& value) {
  return QString::fromLatin1(QUrl::toPercentEncoding(value));
}

void start_embedded_api(int port) {
  std::vector<std::string> args = {
      "steel_capture_qt_terminal",
      "--port",
      std::to_string(port),
  };
  std::thread([args = std::move(args)]() mutable {
    std::vector<char*> argv;
    argv.reserve(args.size());
    for (auto& arg : args) {
      argv.push_back(arg.data());
    }
    run_capture_service_app(static_cast<int>(argv.size()), argv.data());
  }).detach();
}

void log_line(QPlainTextEdit* log, const QString& message) {
  if (!log) {
    return;
  }
  log->appendPlainText(QString("[%1] %2")
                           .arg(QDateTime::currentDateTime().toString("HH:mm:ss"))
                           .arg(message));
}

QString json_to_text(const QJsonObject& json) {
  return QString::fromUtf8(QJsonDocument(json).toJson(QJsonDocument::Indented));
}

int json_code(const QJsonObject& json, int fallback = 0) {
  if (json.contains("code")) {
    return json.value("code").toInt(fallback);
  }
  return fallback;
}

int find_or_add_row(QTableWidget* table, const QString& ip) {
  for (int row = 0; row < table->rowCount(); ++row) {
    auto* item = table->item(row, 0);
    if (item && item->text() == ip) {
      return row;
    }
  }
  const int row = table->rowCount();
  table->insertRow(row);
  table->setItem(row, 0, new QTableWidgetItem(ip));
  for (int column = 1; column < table->columnCount(); ++column) {
    table->setItem(row, column, new QTableWidgetItem("-"));
  }
  return row;
}

void set_cell(QTableWidget* table, int row, int column, const QString& value) {
  auto* item = table->item(row, column);
  if (!item) {
    item = new QTableWidgetItem();
    table->setItem(row, column, item);
  }
  item->setText(value.trimmed().isEmpty() ? "-" : value);
}

void tint_row(QTableWidget* table, int row, const QColor& background, const QColor& foreground = QColor("#edf4f6")) {
  for (int column = 0; column < table->columnCount(); ++column) {
    auto* item = table->item(row, column);
    if (!item) {
      item = new QTableWidgetItem("-");
      table->setItem(row, column, item);
    }
    item->setBackground(QBrush(background));
    item->setForeground(QBrush(foreground));
  }
}

QString selected_ip(QTableWidget* table) {
  const int row = table->currentRow();
  if (row < 0) {
    return {};
  }
  auto* item = table->item(row, 0);
  return item ? item->text().trimmed() : QString();
}

void request_json(QNetworkAccessManager* network,
                  const QString& method,
                  const QString& url,
                  const QJsonObject& body,
                  QPlainTextEdit* log,
                  std::function<void(const QJsonObject&)> on_done) {
  QNetworkRequest request{QUrl(url)};
  request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json; charset=utf-8");

  QNetworkReply* reply = nullptr;
  if (method == "POST") {
    reply = network->post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
  } else {
    reply = network->get(request);
  }

  QObject::connect(reply, &QNetworkReply::finished, [reply, log, on_done = std::move(on_done)]() {
    const QByteArray payload = reply->readAll();
    const QString url = reply->url().toString();
    if (reply->error() != QNetworkReply::NoError) {
      log_line(log, zh(u8"API 请求失败：") + url + " - " + reply->errorString());
      reply->deleteLater();
      return;
    }

    QJsonParseError parse_error{};
    const QJsonDocument doc = QJsonDocument::fromJson(payload, &parse_error);
    if (parse_error.error != QJsonParseError::NoError || !doc.isObject()) {
      log_line(log, zh(u8"接口返回不是有效 JSON：") + url);
      reply->deleteLater();
      return;
    }
    on_done(doc.object());
    reply->deleteLater();
  });
}

void request_image(QNetworkAccessManager* network,
                   const QString& url,
                   std::function<void(const QByteArray&)> on_done) {
  QNetworkRequest request{QUrl(url)};
  auto* reply = network->get(request);
  QObject::connect(reply, &QNetworkReply::finished, [reply, on_done = std::move(on_done)]() {
    const QByteArray payload = reply->readAll();
    if (reply->error() == QNetworkReply::NoError && !payload.isEmpty()) {
      on_done(payload);
    }
    reply->deleteLater();
  });
}

void append_calibration_record(QPlainTextEdit* log, const QJsonObject& record) {
  QString dir_path = QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation);
  if (dir_path.isEmpty()) {
    dir_path = QDir::currentPath() + "/config";
  }
  QDir().mkpath(dir_path);
  const QString file_path = QDir(dir_path).filePath("calibration-records.jsonl");
  QFile file(file_path);
  if (!file.open(QIODevice::Append | QIODevice::Text)) {
    log_line(log, zh(u8"标定记录保存失败：") + file.errorString());
    return;
  }
  file.write(QJsonDocument(record).toJson(QJsonDocument::Compact));
  file.write("\n");
  log_line(log, zh(u8"标定记录已保存：") + file_path);
}

QLabel* small_label(const QString& text) {
  auto* label = new QLabel(text);
  label->setWordWrap(true);
  return label;
}

QLabel* value_label(const QString& text = "-") {
  auto* label = new QLabel(text);
  label->setObjectName("valueLabel");
  label->setTextInteractionFlags(Qt::TextSelectableByMouse);
  label->setWordWrap(true);
  return label;
}

void set_value(QLabel* label, const QString& value) {
  if (label) {
    label->setText(value.trimmed().isEmpty() ? "-" : value);
  }
}

}  // namespace

int main(int argc, char* argv[]) {
  QApplication app(argc, argv);
  QApplication::setApplicationName("steel-capture-qt");
  QApplication::setOrganizationName("steel-plate-3d-inspection");

  const int port = capture_port();
  const QString origin = api_origin(port);
  const char* autostart = std::getenv("CAPTURE_QT_API_AUTOSTART");
  if (autostart == nullptr || std::string(autostart) != "0") {
    start_embedded_api(port);
  }

  QMainWindow window;
  window.setWindowTitle(zh(u8"钢板 3D 采集工作台"));
  window.resize(1480, 900);

  auto* central = new QWidget(&window);
  auto* root = new QVBoxLayout(central);
  root->setContentsMargins(12, 12, 12, 12);
  root->setSpacing(10);

  auto* top_bar = new QHBoxLayout();
  auto* title = new QLabel(zh(u8"钢板 3D 采集工作台"));
  title->setObjectName("title");
  auto* api_state = small_label(zh(u8"内置采集 API 启动中：") + origin);
  auto* provider_hint = small_label(zh(u8"Rust provider：qt-terminal"));
  provider_hint->setObjectName("muted");
  auto* preview_page_button = new QPushButton(zh(u8"相机预览"));
  auto* config_page_button = new QPushButton(zh(u8"配置管理"));
  auto* stability_test_button = new QPushButton(zh(u8"采集稳定性测试"));
  preview_page_button->setObjectName("modeButton");
  config_page_button->setObjectName("modeButton");
  auto* open_api = new QPushButton(zh(u8"打开 API 控制台"));
  top_bar->addWidget(title, 0);
  top_bar->addSpacing(12);
  top_bar->addWidget(api_state, 1);
  top_bar->addWidget(preview_page_button, 0);
  top_bar->addWidget(config_page_button, 0);
  top_bar->addWidget(stability_test_button, 0);
  top_bar->addWidget(provider_hint, 0);
  top_bar->addWidget(open_api, 0);
  root->addLayout(top_bar);

  auto* main_stack = new QStackedWidget();
  root->addWidget(main_stack, 1);

  auto* preview_page = new QWidget();
  auto* preview_page_layout = new QVBoxLayout(preview_page);
  preview_page_layout->setContentsMargins(0, 0, 0, 0);
  preview_page_layout->setSpacing(0);
  auto* splitter = new QSplitter(Qt::Horizontal);
  preview_page_layout->addWidget(splitter, 1);
  main_stack->addWidget(preview_page);

  auto* config_page = new QWidget();
  auto* config_page_layout = new QVBoxLayout(config_page);
  config_page_layout->setContentsMargins(0, 0, 0, 0);
  config_page_layout->setSpacing(8);
  auto* config_manager_group = new QGroupBox(zh(u8"配置组管理"));
  auto* config_manager_layout = new QVBoxLayout(config_manager_group);
  auto* active_profile_label = small_label(zh(u8"当前默认配置：-"));
  auto* profile_manage_table = new QTableWidget(0, 4);
  profile_manage_table->setHorizontalHeaderLabels({
      zh(u8"配置名称"),
      zh(u8"默认"),
      zh(u8"模式"),
      zh(u8"路径"),
  });
  profile_manage_table->horizontalHeader()->setStretchLastSection(true);
  profile_manage_table->horizontalHeader()->setSectionResizeMode(QHeaderView::ResizeToContents);
  profile_manage_table->horizontalHeader()->setSectionResizeMode(3, QHeaderView::Stretch);
  profile_manage_table->verticalHeader()->setVisible(false);
  profile_manage_table->setSelectionBehavior(QAbstractItemView::SelectRows);
  profile_manage_table->setSelectionMode(QAbstractItemView::SingleSelection);
  profile_manage_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  profile_manage_table->setAlternatingRowColors(false);
  auto* config_manager_buttons = new QHBoxLayout();
  auto* profile_new_wizard = new QPushButton(zh(u8"新建配置"));
  auto* profile_import_folder = new QPushButton(zh(u8"导入配置组"));
  auto* profile_import_json = new QPushButton(zh(u8"导入 JSON"));
  auto* profile_apply_selected = new QPushButton(zh(u8"应用/设为默认"));
  auto* profile_refresh_list = new QPushButton(zh(u8"刷新列表"));
  config_manager_buttons->addWidget(profile_new_wizard);
  config_manager_buttons->addWidget(profile_import_folder);
  config_manager_buttons->addWidget(profile_import_json);
  config_manager_buttons->addWidget(profile_apply_selected);
  config_manager_buttons->addWidget(profile_refresh_list);
  config_manager_buttons->addStretch(1);
  config_manager_layout->addWidget(active_profile_label);
  config_manager_layout->addWidget(profile_manage_table);
  config_manager_layout->addLayout(config_manager_buttons);
  config_page_layout->addWidget(config_manager_group, 0);
  main_stack->addWidget(config_page);

  auto* left_panel = new QWidget();
  auto* left_layout = new QVBoxLayout(left_panel);
  left_layout->setContentsMargins(0, 0, 0, 0);
  left_layout->setSpacing(8);
  auto* camera_title = new QLabel(zh(u8"相机列表（目标 6 台）"));
  camera_title->setObjectName("sectionTitle");
  auto* camera_table = new QTableWidget(0, 9);
  camera_table->setHorizontalHeaderLabels({
      zh(u8"IP 地址"),
      zh(u8"型号"),
      zh(u8"序列号"),
      zh(u8"来源"),
      zh(u8"连接"),
      zh(u8"SDK"),
      zh(u8"帧数"),
      zh(u8"状态"),
      zh(u8"选中"),
  });
  camera_table->horizontalHeader()->setStretchLastSection(false);
  camera_table->horizontalHeader()->setSectionResizeMode(QHeaderView::ResizeToContents);
  camera_table->horizontalHeader()->setSectionResizeMode(7, QHeaderView::Stretch);
  camera_table->verticalHeader()->setVisible(false);
  camera_table->setSelectionBehavior(QAbstractItemView::SelectRows);
  camera_table->setSelectionMode(QAbstractItemView::SingleSelection);
  camera_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  camera_table->setAlternatingRowColors(false);
  auto* left_actions = new QGridLayout();
  auto* refresh_button = new QPushButton(zh(u8"刷新"));
  auto* connect_button = new QPushButton(zh(u8"连接选中"));
  auto* auto_connect_button = new QPushButton(zh(u8"自动连接全部"));
  auto* disconnect_button = new QPushButton(zh(u8"断开选中"));
  auto* disconnect_all_button = new QPushButton(zh(u8"全部断开"));
  left_actions->addWidget(refresh_button, 0, 0);
  left_actions->addWidget(connect_button, 0, 1);
  left_actions->addWidget(auto_connect_button, 1, 0, 1, 2);
  left_actions->addWidget(disconnect_button, 2, 0);
  left_actions->addWidget(disconnect_all_button, 2, 1);
  left_layout->addWidget(camera_title);
  left_layout->addWidget(camera_table, 1);
  left_layout->addLayout(left_actions);
  splitter->addWidget(left_panel);

  auto* center_panel = new QWidget();
  auto* center_layout = new QVBoxLayout(center_panel);
  center_layout->setContentsMargins(8, 0, 8, 0);
  center_layout->setSpacing(8);
  auto* preview_title_row = new QHBoxLayout();
  auto* selected_label = new QLabel(zh(u8"未选择相机"));
  selected_label->setObjectName("sectionTitle");
  auto* preview_kind = new QComboBox();
  preview_kind->addItem(zh(u8"深度热力图"), "depth");
  preview_kind->addItem(zh(u8"亮度图"), "intensity");
  preview_title_row->addWidget(selected_label, 1);
  preview_title_row->addWidget(new QLabel(zh(u8"预览")));
  preview_title_row->addWidget(preview_kind, 0);
  auto* preview = new QLabel(zh(u8"选择并连接一台相机后启动实时预览"));
  preview->setAlignment(Qt::AlignCenter);
  preview->setMinimumSize(620, 520);
  preview->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
  preview->setObjectName("preview");
  auto* preview_meta = small_label(zh(u8"帧号 - | 尺寸 - | FPS - | 丢线 - | 温度 - | 触发间隔 -"));
  auto* preview_actions = new QHBoxLayout();
  auto* start_stream = new QPushButton(zh(u8"启动预览"));
  auto* stop_stream = new QPushButton(zh(u8"停止预览"));
  auto* save_frame = new QPushButton(zh(u8"保存当前帧"));
  auto* capture_once = new QPushButton(zh(u8"采集预览帧"));
  preview_actions->addWidget(start_stream);
  preview_actions->addWidget(stop_stream);
  preview_actions->addWidget(save_frame);
  preview_actions->addWidget(capture_once);
  preview_actions->addStretch(1);
  center_layout->addLayout(preview_title_row);
  center_layout->addWidget(preview, 1);
  center_layout->addWidget(preview_meta);
  center_layout->addLayout(preview_actions);
  splitter->addWidget(center_panel);

  auto* tabs = new QTabWidget();
  splitter->addWidget(tabs);
  auto* camera_tabs = new QTabWidget();
  auto* config_tabs = new QTabWidget();
  config_page_layout->addWidget(config_tabs, 1);
  tabs->addTab(camera_tabs, zh(u8"相机"));

  auto* status_tab = new QWidget();
  auto* status_layout = new QVBoxLayout(status_tab);
  auto* status_group = new QGroupBox(zh(u8"实时状态"));
  auto* status_form = new QFormLayout(status_group);
  auto* status_ip = value_label();
  auto* status_connection = value_label();
  auto* status_acquisition = value_label();
  auto* status_stream = value_label();
  auto* status_frames = value_label();
  auto* status_sdk = value_label();
  auto* status_link = value_label();
  auto* status_temperature = value_label();
  auto* status_errors = value_label();
  auto* status_identity = value_label();
  status_form->addRow(zh(u8"IP 地址"), status_ip);
  status_form->addRow(zh(u8"连接状态"), status_connection);
  status_form->addRow(zh(u8"采集状态"), status_acquisition);
  status_form->addRow(zh(u8"预览状态"), status_stream);
  status_form->addRow(zh(u8"帧数"), status_frames);
  status_form->addRow(zh(u8"SDK 状态"), status_sdk);
  status_form->addRow(zh(u8"链路健康"), status_link);
  status_form->addRow(zh(u8"温度"), status_temperature);
  status_form->addRow(zh(u8"计数器"), status_errors);
  status_form->addRow(zh(u8"设备"), status_identity);
  auto* calibration_status_group = new QGroupBox(zh(u8"标定状态"));
  auto* calibration_status_form = new QFormLayout(calibration_status_group);
  auto* calibration_code = value_label();
  auto* calibration_path_value = value_label();
  auto* roi_code = value_label();
  auto* roi_path_value = value_label();
  auto* calibration_time = value_label();
  calibration_status_form->addRow(zh(u8"标定返回码"), calibration_code);
  calibration_status_form->addRow(zh(u8"标定文件"), calibration_path_value);
  calibration_status_form->addRow(zh(u8"ROI 返回码"), roi_code);
  calibration_status_form->addRow(zh(u8"ROI 文件"), roi_path_value);
  calibration_status_form->addRow(zh(u8"最近更新"), calibration_time);
  status_layout->addWidget(status_group);
  status_layout->addWidget(calibration_status_group);
  status_layout->addStretch(1);
  camera_tabs->addTab(status_tab, zh(u8"实时状态"));

  auto* storage_tab = new QWidget();
  auto* storage_layout = new QVBoxLayout(storage_tab);
  auto* storage_group = new QGroupBox(zh(u8"数据存储设置"));
  auto* storage_form = new QFormLayout(storage_group);
  auto* storage_root = new QLineEdit("E:/steel-capture-data");
  auto* storage_browse = new QPushButton(zh(u8"选择目录"));
  auto* storage_apply = new QPushButton(zh(u8"应用存储目录"));
  auto* storage_open = new QPushButton(zh(u8"打开位置"));
  auto* storage_refresh = new QPushButton(zh(u8"刷新状态"));
  auto* storage_row = new QHBoxLayout();
  storage_row->addWidget(storage_root, 1);
  storage_row->addWidget(storage_browse);
  storage_row->addWidget(storage_apply);
  storage_row->addWidget(storage_open);
  storage_row->addWidget(storage_refresh);
  storage_form->addRow(zh(u8"存储根目录"), storage_row);
  auto* storage_status_text = new QPlainTextEdit();
  storage_status_text->setReadOnly(true);
  storage_status_text->setMinimumHeight(180);
  storage_layout->addWidget(storage_group);
  storage_layout->addWidget(storage_status_text, 1);
  config_tabs->addTab(storage_tab, zh(u8"存储配置"));

  auto* camera_config_tab = new QWidget();
  auto* camera_config_layout = new QVBoxLayout(camera_config_tab);
  auto* profile_camera_table = new QTableWidget(0, 8);
  profile_camera_table->setHorizontalHeaderLabels({
      zh(u8"IP 地址"),
      zh(u8"启用"),
      zh(u8"型号"),
      zh(u8"序列号"),
      zh(u8"参数文件"),
      zh(u8"曝光"),
      zh(u8"增益"),
      zh(u8"触发频率"),
  });
  profile_camera_table->horizontalHeader()->setStretchLastSection(false);
  profile_camera_table->horizontalHeader()->setSectionResizeMode(QHeaderView::ResizeToContents);
  profile_camera_table->horizontalHeader()->setSectionResizeMode(4, QHeaderView::Stretch);
  profile_camera_table->verticalHeader()->setVisible(false);
  profile_camera_table->setSelectionBehavior(QAbstractItemView::SelectRows);
  profile_camera_table->setSelectionMode(QAbstractItemView::SingleSelection);
  profile_camera_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  auto* camera_edit_group = new QGroupBox(zh(u8"单台相机配置编辑"));
  auto* camera_edit_form = new QFormLayout(camera_edit_group);
  auto* edit_camera_ip = new QLineEdit();
  auto* edit_camera_enabled = new QCheckBox(zh(u8"启用此相机"));
  edit_camera_enabled->setChecked(true);
  auto* edit_camera_model = new QLineEdit();
  auto* edit_camera_sn = new QLineEdit();
  auto* edit_camera_param_file = new QLineEdit();
  auto* edit_camera_param_browse = new QPushButton(zh(u8"选择"));
  auto* edit_camera_param_row = new QHBoxLayout();
  edit_camera_param_row->addWidget(edit_camera_param_file, 1);
  edit_camera_param_row->addWidget(edit_camera_param_browse);
  auto* edit_camera_exposure = new QSpinBox();
  edit_camera_exposure->setRange(1, 10000000);
  edit_camera_exposure->setValue(1000);
  auto* edit_camera_gain = new QDoubleSpinBox();
  edit_camera_gain->setRange(0.0, 64.0);
  edit_camera_gain->setDecimals(3);
  edit_camera_gain->setValue(1.0);
  auto* edit_camera_trigger_freq = new QDoubleSpinBox();
  edit_camera_trigger_freq->setRange(0.1, 100000.0);
  edit_camera_trigger_freq->setDecimals(2);
  edit_camera_trigger_freq->setValue(300.0);
  auto* camera_config_buttons = new QHBoxLayout();
  auto* profile_camera_sync = new QPushButton(zh(u8"从相机列表同步"));
  auto* profile_camera_update = new QPushButton(zh(u8"添加/更新"));
  auto* profile_camera_delete = new QPushButton(zh(u8"删除选中"));
  auto* profile_camera_write_profile = new QPushButton(zh(u8"写入配置 JSON"));
  camera_config_buttons->addWidget(profile_camera_sync);
  camera_config_buttons->addWidget(profile_camera_update);
  camera_config_buttons->addWidget(profile_camera_delete);
  camera_config_buttons->addWidget(profile_camera_write_profile);
  camera_config_buttons->addStretch(1);
  camera_edit_form->addRow(zh(u8"IP 地址"), edit_camera_ip);
  camera_edit_form->addRow(edit_camera_enabled);
  camera_edit_form->addRow(zh(u8"型号"), edit_camera_model);
  camera_edit_form->addRow(zh(u8"序列号"), edit_camera_sn);
  camera_edit_form->addRow(zh(u8"参数文件"), edit_camera_param_row);
  camera_edit_form->addRow(zh(u8"曝光"), edit_camera_exposure);
  camera_edit_form->addRow(zh(u8"增益"), edit_camera_gain);
  camera_edit_form->addRow(zh(u8"触发频率"), edit_camera_trigger_freq);
  camera_edit_form->addRow(camera_config_buttons);
  camera_config_layout->addWidget(profile_camera_table, 1);
  camera_config_layout->addWidget(camera_edit_group, 0);
  config_tabs->addTab(camera_config_tab, zh(u8"相机配置"));

  auto* control_tab = new QWidget();
  auto* control_layout = new QVBoxLayout(control_tab);
  auto* capture_group = new QGroupBox(zh(u8"单相机采集控制"));
  auto* capture_form = new QFormLayout(capture_group);
  auto* exposure = new QSpinBox();
  exposure->setRange(1, 10000000);
  exposure->setValue(1000);
  auto* gain = new QDoubleSpinBox();
  gain->setRange(0.0, 64.0);
  gain->setDecimals(3);
  gain->setValue(1.0);
  auto* lines = new QSpinBox();
  lines->setRange(1, 100000);
  lines->setValue(1000);
  auto* width = new QSpinBox();
  width->setRange(0, 32768);
  width->setValue(0);
  width->setSpecialValueText(zh(u8"自动"));
  auto* timeout_ms = new QSpinBox();
  timeout_ms->setRange(100, 120000);
  timeout_ms->setValue(8000);
  timeout_ms->setSuffix(" ms");
  auto* fps_limit = new QSpinBox();
  fps_limit->setRange(1, 30);
  fps_limit->setValue(5);
  auto* trigger_freq = new QDoubleSpinBox();
  trigger_freq->setRange(0.1, 100000.0);
  trigger_freq->setDecimals(2);
  trigger_freq->setValue(300.0);
  auto* data_mode = new QComboBox();
  data_mode->addItem(zh(u8"深度"), 1);
  data_mode->addItem(zh(u8"深度 + 亮度"), 2);
  auto* high_speed = new QCheckBox(zh(u8"高速模式"));
  auto* soft_trigger = new QCheckBox(zh(u8"软触发"));
  soft_trigger->setChecked(true);
  soft_trigger->setEnabled(false);
  auto* apply_params = new QPushButton(zh(u8"应用曝光/增益/触发"));
  auto* enforce_soft_trigger = new QPushButton(zh(u8"写入软触发"));
  capture_form->addRow(zh(u8"曝光"), exposure);
  capture_form->addRow(zh(u8"增益"), gain);
  capture_form->addRow(zh(u8"采集行数"), lines);
  capture_form->addRow(zh(u8"宽度"), width);
  capture_form->addRow(zh(u8"超时"), timeout_ms);
  capture_form->addRow(zh(u8"FPS 限制"), fps_limit);
  capture_form->addRow(zh(u8"触发频率"), trigger_freq);
  capture_form->addRow(zh(u8"数据模式"), data_mode);
  capture_form->addRow(high_speed, soft_trigger);
  capture_form->addRow(apply_params, enforce_soft_trigger);

  auto* param_group = new QGroupBox(zh(u8"任意参数读写"));
  auto* param_form = new QFormLayout(param_group);
  auto* param_key = new QLineEdit("ExposureTime");
  auto* param_type = new QComboBox();
  param_type->addItem("int", "int");
  param_type->addItem("float", "float");
  param_type->addItem("string", "string");
  auto* param_value = new QLineEdit("1000");
  auto* param_result = new QPlainTextEdit();
  param_result->setReadOnly(true);
  param_result->setMaximumHeight(110);
  auto* param_buttons = new QHBoxLayout();
  auto* read_param = new QPushButton(zh(u8"读取"));
  auto* write_param = new QPushButton(zh(u8"写入"));
  param_buttons->addWidget(read_param);
  param_buttons->addWidget(write_param);
  param_form->addRow(zh(u8"参数名"), param_key);
  param_form->addRow(zh(u8"类型"), param_type);
  param_form->addRow(zh(u8"值"), param_value);
  param_form->addRow(param_buttons);
  param_form->addRow(param_result);

  control_layout->addWidget(capture_group);
  control_layout->addWidget(param_group);
  control_layout->addStretch(1);
  camera_tabs->addTab(control_tab, zh(u8"单相机控制"));

  auto* calibration_tab = new QWidget();
  auto* calibration_layout = new QVBoxLayout(calibration_tab);
  auto* calibration_group = new QGroupBox(zh(u8"加载 / 应用 / 验证 / 记录"));
  auto* calibration_form = new QFormLayout(calibration_group);
  auto* calibration_path = new QLineEdit();
  auto* calibration_browse = new QPushButton(zh(u8"选择标定文件"));
  auto* calibration_apply = new QPushButton(zh(u8"应用标定"));
  auto* roi_path = new QLineEdit();
  auto* roi_browse = new QPushButton(zh(u8"选择 ROI 文件"));
  auto* roi_apply = new QPushButton(zh(u8"应用 ROI"));
  auto* validation_output = new QLineEdit("calibration/validation.png");
  auto* validation_capture = new QPushButton(zh(u8"采集验证帧并记录"));
  auto* calibration_row = new QHBoxLayout();
  calibration_row->addWidget(calibration_path, 1);
  calibration_row->addWidget(calibration_browse);
  calibration_row->addWidget(calibration_apply);
  auto* roi_row = new QHBoxLayout();
  roi_row->addWidget(roi_path, 1);
  roi_row->addWidget(roi_browse);
  roi_row->addWidget(roi_apply);
  auto* validation_row = new QHBoxLayout();
  validation_row->addWidget(validation_output, 1);
  validation_row->addWidget(validation_capture);
  calibration_form->addRow(zh(u8"标定文件"), calibration_row);
  calibration_form->addRow(zh(u8"ROI 文件"), roi_row);
  calibration_form->addRow(zh(u8"验证帧"), validation_row);
  auto* calibration_log = new QPlainTextEdit();
  calibration_log->setReadOnly(true);
  calibration_layout->addWidget(calibration_group);
  calibration_layout->addWidget(calibration_log, 1);

  auto* profile_tab = new QWidget();
  auto* profile_layout = new QVBoxLayout(profile_tab);
  auto* profile_group = new QGroupBox(zh(u8"全局采集配置"));
  auto* profile_form = new QFormLayout(profile_group);
  auto* profile_name = new QLineEdit("default");
  auto* profile_driver_mode = new QComboBox();
  profile_driver_mode->addItem(zh(u8"真实 SDK"), "lvm");
  profile_driver_mode->addItem(zh(u8"离线模拟"), "simulated");
  auto* profile_startup_mode = new QComboBox();
  profile_startup_mode->addItem(zh(u8"手动启动"), "manual");
  profile_startup_mode->addItem(zh(u8"启动后自动连接"), "auto-connect");
  profile_startup_mode->addItem(zh(u8"启动后自动连接并连续测试"), "auto-connect-continuous");
  auto* profile_expected_cameras = new QSpinBox();
  profile_expected_cameras->setRange(1, 24);
  profile_expected_cameras->setValue(6);
  auto* profile_auto_connect = new QCheckBox(zh(u8"应用配置时自动连接相机"));
  profile_auto_connect->setChecked(true);
  auto* profile_load_camera_params = new QCheckBox(zh(u8"应用配置时加载相机参数文件"));
  auto* profile_save_to_device = new QCheckBox(zh(u8"应用后保存到相机设备"));
  auto* profile_change_storage = new QCheckBox(zh(u8"应用配置时切换存储根目录"));
  auto* profile_camera_param_dir = new QLineEdit("config/camera-params/default");
  auto* profile_param_dir_browse = new QPushButton(zh(u8"选择目录"));
  auto* profile_param_dir_row = new QHBoxLayout();
  profile_param_dir_row->addWidget(profile_camera_param_dir, 1);
  profile_param_dir_row->addWidget(profile_param_dir_browse);
  auto* profile_buttons = new QHBoxLayout();
  auto* profile_refresh = new QPushButton(zh(u8"刷新配置状态"));
  auto* profile_generate = new QPushButton(zh(u8"生成当前配置"));
  auto* profile_save = new QPushButton(zh(u8"保存配置文件"));
  auto* profile_apply = new QPushButton(zh(u8"应用/切换配置"));
  profile_buttons->addWidget(profile_refresh);
  profile_buttons->addWidget(profile_generate);
  profile_buttons->addWidget(profile_save);
  profile_buttons->addWidget(profile_apply);
  auto* profile_param_buttons = new QHBoxLayout();
  auto* profile_save_camera_params = new QPushButton(zh(u8"保存全部相机参数文件"));
  auto* profile_load_camera_params_button = new QPushButton(zh(u8"加载全部相机参数文件"));
  profile_param_buttons->addWidget(profile_save_camera_params);
  profile_param_buttons->addWidget(profile_load_camera_params_button);
  auto* profile_json = new QPlainTextEdit();
  profile_json->setMinimumHeight(260);
  auto* profile_result = new QPlainTextEdit();
  profile_result->setReadOnly(true);
  profile_result->setMinimumHeight(150);
  profile_form->addRow(zh(u8"配置名称"), profile_name);
  profile_form->addRow(zh(u8"运行模式"), profile_driver_mode);
  profile_form->addRow(zh(u8"采集启动模式"), profile_startup_mode);
  profile_form->addRow(zh(u8"期望相机数"), profile_expected_cameras);
  profile_form->addRow(profile_auto_connect);
  profile_form->addRow(profile_load_camera_params);
  profile_form->addRow(profile_save_to_device);
  profile_form->addRow(profile_change_storage);
  profile_form->addRow(zh(u8"相机参数文件夹"), profile_param_dir_row);
  profile_form->addRow(profile_buttons);
  profile_form->addRow(profile_param_buttons);
  profile_layout->addWidget(profile_group);
  profile_layout->addWidget(new QLabel(zh(u8"配置 JSON")));
  profile_layout->addWidget(profile_json, 1);
  profile_layout->addWidget(new QLabel(zh(u8"API 返回")));
  profile_layout->addWidget(profile_result, 1);
  config_tabs->addTab(profile_tab, zh(u8"全局配置"));
  config_tabs->addTab(calibration_tab, zh(u8"标定流程"));

  auto* continuous_tab = new QWidget();
  auto* continuous_layout = new QVBoxLayout(continuous_tab);
  auto* continuous_group = new QGroupBox(zh(u8"自动连接与连续采集测试"));
  auto* continuous_form = new QFormLayout(continuous_group);
  auto* expected_camera_count = new QSpinBox();
  expected_camera_count->setRange(1, 24);
  expected_camera_count->setValue(6);
  auto* continuous_rounds = new QSpinBox();
  continuous_rounds->setRange(1, 10000);
  continuous_rounds->setValue(3);
  auto* continuous_interval_ms = new QSpinBox();
  continuous_interval_ms->setRange(0, 600000);
  continuous_interval_ms->setValue(500);
  continuous_interval_ms->setSuffix(" ms");
  auto* continuous_scope = new QComboBox();
  continuous_scope->addItem(zh(u8"全部已发现相机"), "all");
  continuous_scope->addItem(zh(u8"当前选中相机"), "selected");
  auto* continuous_output_dir = new QLineEdit("continuous-test");
  auto* continuous_output_browse = new QPushButton(zh(u8"选择目录"));
  auto* continuous_output_row = new QHBoxLayout();
  continuous_output_row->addWidget(continuous_output_dir, 1);
  continuous_output_row->addWidget(continuous_output_browse);
  auto* continuous_buttons = new QHBoxLayout();
  auto* continuous_auto_connect = new QPushButton(zh(u8"自动连接"));
  auto* continuous_start = new QPushButton(zh(u8"开始连续采集"));
  auto* continuous_stop = new QPushButton(zh(u8"停止测试"));
  continuous_stop->setEnabled(false);
  continuous_buttons->addWidget(continuous_auto_connect);
  continuous_buttons->addWidget(continuous_start);
  continuous_buttons->addWidget(continuous_stop);
  continuous_form->addRow(zh(u8"期望相机数"), expected_camera_count);
  continuous_form->addRow(zh(u8"测试范围"), continuous_scope);
  continuous_form->addRow(zh(u8"轮数"), continuous_rounds);
  continuous_form->addRow(zh(u8"间隔"), continuous_interval_ms);
  continuous_form->addRow(zh(u8"输出目录"), continuous_output_row);
  continuous_form->addRow(continuous_buttons);
  auto* continuous_summary = small_label(zh(u8"等待测试"));
  auto* continuous_table = new QTableWidget(0, 7);
  continuous_table->setHorizontalHeaderLabels({
      zh(u8"IP 地址"),
      zh(u8"连接"),
      zh(u8"尝试"),
      zh(u8"成功"),
      zh(u8"失败"),
      zh(u8"返回码"),
      zh(u8"最新输出"),
  });
  continuous_table->horizontalHeader()->setStretchLastSection(true);
  continuous_table->horizontalHeader()->setSectionResizeMode(QHeaderView::ResizeToContents);
  continuous_table->horizontalHeader()->setSectionResizeMode(6, QHeaderView::Stretch);
  continuous_table->verticalHeader()->setVisible(false);
  continuous_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  auto* continuous_log = new QPlainTextEdit();
  continuous_log->setReadOnly(true);
  continuous_log->setMaximumBlockCount(1000);
  continuous_layout->addWidget(continuous_group);
  continuous_layout->addWidget(continuous_summary);
  continuous_layout->addWidget(continuous_table, 1);
  continuous_layout->addWidget(continuous_log, 1);
  camera_tabs->addTab(continuous_tab, zh(u8"连续测试"));

  auto* log_tab = new QWidget();
  auto* log_layout = new QVBoxLayout(log_tab);
  auto* log = new QPlainTextEdit();
  log->setReadOnly(true);
  log->setMaximumBlockCount(1000);
  log_layout->addWidget(log);
  tabs->addTab(log_tab, zh(u8"日志"));

  splitter->setStretchFactor(0, 0);
  splitter->setStretchFactor(1, 1);
  splitter->setStretchFactor(2, 0);
  splitter->setSizes({360, 760, 420});

  window.setCentralWidget(central);
  window.setStyleSheet(
      "QMainWindow, QWidget { background: #11181c; color: #edf4f6; font-family: 'Microsoft YaHei UI', 'Segoe UI'; font-size: 13px; }"
      "QLabel#title { font-size: 22px; font-weight: 700; color: #ffffff; }"
      "QLabel#sectionTitle { font-size: 15px; font-weight: 700; color: #ffffff; }"
      "QLabel#muted { color: #9fb2ba; }"
      "QLabel#valueLabel { color: #e8f4f6; background: #0b1114; border: 1px solid #263840; border-radius: 4px; padding: 5px 7px; }"
      "QLabel#preview { background: #05090b; border: 1px solid #2b3f48; border-radius: 6px; color: #8ea3ac; }"
      "QTableWidget, QPlainTextEdit, QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox { background: #0b1114; color: #edf4f6; border: 1px solid #2a3c44; border-radius: 4px; selection-background-color: #176b7b; }"
      "QHeaderView::section { background: #162229; color: #dcecef; border: 0; padding: 5px; }"
      "QGroupBox { border: 1px solid #2a3c44; border-radius: 6px; margin-top: 14px; padding: 10px; font-weight: 700; }"
      "QGroupBox::title { subcontrol-origin: margin; left: 8px; padding: 0 4px; }"
      "QPushButton { background: #155b68; color: #effcff; border: 1px solid #2e8798; border-radius: 5px; padding: 7px 10px; font-weight: 700; }"
      "QPushButton:hover { background: #1b7080; }"
      "QPushButton:pressed { background: #0f4a55; }"
      "QTabWidget::pane { border: 1px solid #2a3c44; }"
      "QTabBar::tab { background: #17242a; color: #d7e8eb; padding: 8px 12px; }"
      "QTabBar::tab:selected { background: #1d6571; color: #ffffff; }"
      "QCheckBox { spacing: 8px; }");

  auto* network = new QNetworkAccessManager(&window);
  auto* poll_timer = new QTimer(&window);
  auto* preview_timer = new QTimer(&window);
  auto* continuous_timer = new QTimer(&window);
  preview_timer->setInterval(350);
  continuous_timer->setSingleShot(true);

  auto attach_json_highlight = [](QPlainTextEdit* edit) {
    if (edit) {
      new JsonHighlighter(edit->document());
    }
  };
  attach_json_highlight(storage_status_text);
  attach_json_highlight(param_result);
  attach_json_highlight(calibration_log);
  attach_json_highlight(profile_json);
  attach_json_highlight(profile_result);

  QString active_stream_ip;
  QByteArray latest_preview_bytes;
  QJsonObject selected_status;
  QJsonObject stream_status;
  int last_frame_count = 0;
  qint64 last_fps_sample_ms = 0;
  double measured_fps = 0.0;
  bool selection_change_guard = false;
  bool continuous_running = false;
  QStringList continuous_ips;
  int continuous_round = 1;
  int continuous_index = 0;
  int continuous_total_attempts = 0;
  int continuous_total_success = 0;
  int continuous_total_failure = 0;

  struct ContinuousStats {
    int attempts = 0;
    int successes = 0;
    int failures = 0;
    int last_code = 0;
    QString connection = "-";
    QString latest_output;
  };
  std::map<QString, ContinuousStats> continuous_stats;

  auto selected_or_log = [&]() -> QString {
    const QString ip = selected_ip(camera_table);
    if (ip.isEmpty()) {
      log_line(log, zh(u8"请先选择一台相机。"));
    }
    return ip;
  };

  auto continuous_log_line = [&](const QString& message) {
    log_line(continuous_log, message);
    log_line(log, message);
  };

  auto safe_file_ip = [](QString ip) {
    ip.replace('.', '_');
    ip.replace(':', '_');
    ip.replace('/', '_');
    ip.replace('\\', '_');
    return ip;
  };

  auto camera_param_path_for_ip = [&](const QString& ip) {
    const QString base = profile_camera_param_dir->text().trimmed().isEmpty() ? "camera-params" : profile_camera_param_dir->text().trimmed();
    return QDir(base).filePath(safe_file_ip(ip) + ".nccfg");
  };

  auto apply_camera_row_style = [&](int row, bool connected, bool streaming, const QString& state) {
    QColor background("#11181c");
    if (streaming) {
      background = QColor("#103d47");
    } else if (connected) {
      background = QColor("#142d20");
    } else if (state == "discovered" || state == zh(u8"已发现")) {
      background = QColor("#2a2416");
    } else {
      background = QColor("#261b1d");
    }
    tint_row(camera_table, row, background);
  };

  auto update_camera_selection_markers = [&]() {
    for (int row = 0; row < camera_table->rowCount(); ++row) {
      set_cell(camera_table, row, 8, row == camera_table->currentRow() ? zh(u8"当前") : "");
    }
  };

  auto profile_camera_row_for_ip = [&](const QString& ip) {
    for (int row = 0; row < profile_camera_table->rowCount(); ++row) {
      auto* item = profile_camera_table->item(row, 0);
      if (item && item->text().trimmed() == ip) {
        return row;
      }
    }
    const int row = profile_camera_table->rowCount();
    profile_camera_table->insertRow(row);
    for (int column = 0; column < profile_camera_table->columnCount(); ++column) {
      profile_camera_table->setItem(row, column, new QTableWidgetItem("-"));
    }
    return row;
  };

  auto set_profile_camera_row = [&](int row, const QJsonObject& camera) {
    const QString ip = camera.value("ip").toString();
    const QJsonObject params = camera.value("params").toObject();
    set_cell(profile_camera_table, row, 0, ip);
    set_cell(profile_camera_table, row, 1, camera.value("enabled").toBool(true) ? zh(u8"是") : zh(u8"否"));
    set_cell(profile_camera_table, row, 2, camera.value("model").toString());
    set_cell(profile_camera_table, row, 3, camera.value("sn").toString());
    set_cell(profile_camera_table, row, 4, camera.value("paramFile").toString(camera_param_path_for_ip(ip)));
    set_cell(profile_camera_table, row, 5, QString::number(params.value("exposureTime").toInt(exposure->value())));
    set_cell(profile_camera_table, row, 6, QString::number(params.value("gainK").toDouble(gain->value()), 'f', 3));
    set_cell(profile_camera_table, row, 7, QString::number(params.value("timeTriggerFreq").toDouble(trigger_freq->value()), 'f', 2));
  };

  auto current_profile_camera_object = [&]() {
    const QString ip = edit_camera_ip->text().trimmed();
    if (ip.isEmpty()) {
      return QJsonObject{};
    }
    return QJsonObject{
        {"ip", ip},
        {"enabled", edit_camera_enabled->isChecked()},
        {"model", edit_camera_model->text().trimmed()},
        {"sn", edit_camera_sn->text().trimmed()},
        {"paramFile", edit_camera_param_file->text().trimmed().isEmpty() ? camera_param_path_for_ip(ip) : edit_camera_param_file->text().trimmed()},
        {"params", QJsonObject{
                       {"exposureTime", edit_camera_exposure->value()},
                       {"gainK", edit_camera_gain->value()},
                       {"timeTriggerFreq", edit_camera_trigger_freq->value()},
                   }},
    };
  };

  auto profile_cameras_from_table = [&]() {
    QJsonArray cameras;
    for (int row = 0; row < profile_camera_table->rowCount(); ++row) {
      const QString ip = profile_camera_table->item(row, 0) ? profile_camera_table->item(row, 0)->text().trimmed() : QString();
      if (ip.isEmpty() || ip == "-") {
        continue;
      }
      const QString enabled_text = profile_camera_table->item(row, 1) ? profile_camera_table->item(row, 1)->text().trimmed() : zh(u8"是");
      const int exposure_value = profile_camera_table->item(row, 5) ? profile_camera_table->item(row, 5)->text().toInt() : exposure->value();
      const double gain_value = profile_camera_table->item(row, 6) ? profile_camera_table->item(row, 6)->text().toDouble() : gain->value();
      const double trigger_value = profile_camera_table->item(row, 7) ? profile_camera_table->item(row, 7)->text().toDouble() : trigger_freq->value();
      cameras.append(QJsonObject{
          {"ip", ip},
          {"enabled", enabled_text != zh(u8"否") && enabled_text != "false" && enabled_text != "0"},
          {"model", profile_camera_table->item(row, 2) ? profile_camera_table->item(row, 2)->text() : ""},
          {"sn", profile_camera_table->item(row, 3) ? profile_camera_table->item(row, 3)->text() : ""},
          {"paramFile", profile_camera_table->item(row, 4) ? profile_camera_table->item(row, 4)->text() : camera_param_path_for_ip(ip)},
          {"params", QJsonObject{
                         {"exposureTime", exposure_value},
                         {"gainK", gain_value},
                         {"timeTriggerFreq", trigger_value},
                     }},
      });
    }
    return cameras;
  };

  auto camera_ips_from_table = [&]() {
    QStringList ips;
    for (int row = 0; row < camera_table->rowCount(); ++row) {
      auto* item = camera_table->item(row, 0);
      const QString ip = item ? item->text().trimmed() : QString();
      if (!ip.isEmpty() && !ips.contains(ip)) {
        ips.append(ip);
      }
    }
    return ips;
  };

  auto profile_object_from_editor = [&]() {
    QJsonParseError parse_error{};
    const QJsonDocument doc = QJsonDocument::fromJson(profile_json->toPlainText().toUtf8(), &parse_error);
    if (parse_error.error != QJsonParseError::NoError || !doc.isObject()) {
      log_line(log, zh(u8"配置 JSON 无效：") + parse_error.errorString());
      return QJsonObject{};
    }
    return doc.object();
  };

  auto build_profile_object = [&]() {
    QJsonArray cameras = profile_cameras_from_table();
    if (cameras.isEmpty()) {
      for (int row = 0; row < camera_table->rowCount(); ++row) {
        const QString ip = camera_table->item(row, 0) ? camera_table->item(row, 0)->text().trimmed() : QString();
        if (ip.isEmpty()) {
          continue;
        }
        cameras.append(QJsonObject{
            {"ip", ip},
            {"model", camera_table->item(row, 1) ? camera_table->item(row, 1)->text() : ""},
            {"sn", camera_table->item(row, 2) ? camera_table->item(row, 2)->text() : ""},
            {"enabled", true},
            {"paramFile", camera_param_path_for_ip(ip)},
            {"params", QJsonObject{
                           {"exposureTime", exposure->value()},
                           {"gainK", gain->value()},
                           {"timeTriggerFreq", trigger_freq->value()},
                       }},
        });
      }
    }

    QJsonObject profile{
        {"schema", "steel.capture.profile.v1"},
        {"name", profile_name->text().trimmed().isEmpty() ? "default" : profile_name->text().trimmed()},
        {"updatedAt", QDateTime::currentDateTime().toString(Qt::ISODateWithMs)},
        {"driverMode", profile_driver_mode->currentData().toString()},
        {"storageRoot", storage_root->text().trimmed()},
        {"cameraParamDir", profile_camera_param_dir->text().trimmed()},
        {"startupMode", profile_startup_mode->currentData().toString()},
        {"autoConnect", profile_auto_connect->isChecked()},
        {"expectedCameras", profile_expected_cameras->value()},
        {"devType", -1},
        {"changeStorage", profile_change_storage->isChecked()},
        {"applySoftTrigger", true},
        {"loadCameraParams", profile_load_camera_params->isChecked()},
        {"saveToDevice", profile_save_to_device->isChecked()},
        {"lines", lines->value()},
        {"width", width->value()},
        {"timeoutMs", timeout_ms->value()},
        {"dataMode", data_mode->currentData().toInt()},
        {"fpsLimit", fps_limit->value()},
        {"controlMode", 2},
        {"triggerInputType", 4},
        {"divRatio", 4},
        {"timeTriggerFreq", trigger_freq->value()},
        {"exposureTime", exposure->value()},
        {"gainK", gain->value()},
        {"cameraDefaults", QJsonObject{
                               {"controlMode", 2},
                               {"triggerInputType", 4},
                               {"divRatio", 4},
                               {"timeTriggerFreq", trigger_freq->value()},
                               {"exposureTime", exposure->value()},
                               {"gainK", gain->value()},
                           }},
        {"simulated", QJsonObject{
                          {"imageSourceDir", ""},
                      }},
        {"cameras", cameras},
    };
    return profile;
  };

  auto render_profile_object = [&](const QJsonObject& profile) {
    profile_json->setPlainText(QString::fromUtf8(QJsonDocument(profile).toJson(QJsonDocument::Indented)));
    if (profile.contains("name")) {
      profile_name->setText(profile.value("name").toString("default"));
    }
    if (profile.contains("storageRoot")) {
      storage_root->setText(profile.value("storageRoot").toString(storage_root->text()));
    }
    if (profile.contains("driverMode")) {
      const int index = profile_driver_mode->findData(profile.value("driverMode").toString("lvm"));
      if (index >= 0) {
        profile_driver_mode->setCurrentIndex(index);
      }
    }
    if (profile.contains("cameraParamDir")) {
      profile_camera_param_dir->setText(profile.value("cameraParamDir").toString("config/camera-params/default"));
    }
    if (profile.contains("startupMode")) {
      const QString mode = profile.value("startupMode").toString("manual");
      const int index = profile_startup_mode->findData(mode);
      if (index >= 0) {
        profile_startup_mode->setCurrentIndex(index);
      }
    }
    if (profile.contains("autoConnect")) profile_auto_connect->setChecked(profile.value("autoConnect").toBool());
    if (profile.contains("loadCameraParams")) profile_load_camera_params->setChecked(profile.value("loadCameraParams").toBool());
    if (profile.contains("saveToDevice")) profile_save_to_device->setChecked(profile.value("saveToDevice").toBool());
    if (profile.contains("changeStorage")) profile_change_storage->setChecked(profile.value("changeStorage").toBool());
    if (profile.contains("expectedCameras")) profile_expected_cameras->setValue(profile.value("expectedCameras").toInt(6));
    profile_camera_table->setRowCount(0);
    const QJsonArray cameras = profile.value("cameras").toArray();
    for (const QJsonValue& value : cameras) {
      const QJsonObject camera = value.toObject();
      const QString ip = camera.value("ip").toString().trimmed();
      if (ip.isEmpty()) {
        continue;
      }
      set_profile_camera_row(profile_camera_row_for_ip(ip), camera);
    }
  };

  auto render_profile_entries = [&](const QJsonObject& status) {
    profile_manage_table->setRowCount(0);
    const QJsonArray entries = status.value("profileEntries").toArray();
    const QString active_profile = status.value("activeProfile").toString();
    active_profile_label->setText(active_profile.isEmpty() ? zh(u8"当前默认配置：-")
                                                           : QString(zh(u8"当前默认配置：%1")).arg(active_profile));
    int active_row = -1;
    for (const QJsonValue& value : entries) {
      const QJsonObject entry = value.toObject();
      const int row = profile_manage_table->rowCount();
      profile_manage_table->insertRow(row);
      profile_manage_table->setItem(row, 0, new QTableWidgetItem(entry.value("name").toString()));
      const bool active = entry.value("active").toBool();
      profile_manage_table->setItem(row, 1, new QTableWidgetItem(active ? zh(u8"当前默认") : zh(u8"否")));
      profile_manage_table->setItem(row, 2, new QTableWidgetItem(entry.value("driverMode").toString("-")));
      profile_manage_table->setItem(row, 3, new QTableWidgetItem(entry.value("path").toString()));
      tint_row(profile_manage_table, row, active ? QColor("#173526") : QColor("#0b1114"));
      if (active) {
        active_row = row;
      }
    }
    if (active_row >= 0) {
      profile_manage_table->selectRow(active_row);
    }
  };

  auto continuous_row_for_ip = [&](const QString& ip) {
    for (int row = 0; row < continuous_table->rowCount(); ++row) {
      auto* item = continuous_table->item(row, 0);
      if (item && item->text() == ip) {
        return row;
      }
    }
    const int row = continuous_table->rowCount();
    continuous_table->insertRow(row);
    continuous_table->setItem(row, 0, new QTableWidgetItem(ip));
    for (int column = 1; column < continuous_table->columnCount(); ++column) {
      continuous_table->setItem(row, column, new QTableWidgetItem("-"));
    }
    return row;
  };

  auto update_continuous_summary = [&]() {
    continuous_summary->setText(QString(zh(u8"状态：%1 | 第 %2/%3 轮 | 尝试 %4 | 成功 %5 | 失败 %6"))
                                    .arg(continuous_running ? zh(u8"运行中") : zh(u8"已停止"))
                                    .arg(continuous_round)
                                    .arg(continuous_rounds->value())
                                    .arg(continuous_total_attempts)
                                    .arg(continuous_total_success)
                                    .arg(continuous_total_failure));
  };

  auto update_continuous_row = [&](const QString& ip) {
    const int row = continuous_row_for_ip(ip);
    const auto found = continuous_stats.find(ip);
    const ContinuousStats stats = found == continuous_stats.end() ? ContinuousStats{} : found->second;
    set_cell(continuous_table, row, 1, stats.connection);
    set_cell(continuous_table, row, 2, QString::number(stats.attempts));
    set_cell(continuous_table, row, 3, QString::number(stats.successes));
    set_cell(continuous_table, row, 4, QString::number(stats.failures));
    set_cell(continuous_table, row, 5, QString::number(stats.last_code));
    set_cell(continuous_table, row, 6, stats.latest_output);
    update_continuous_summary();
  };

  auto reset_continuous_table = [&](const QStringList& ips) {
    continuous_table->setRowCount(0);
    continuous_stats.clear();
    for (const QString& ip : ips) {
      continuous_stats[ip] = ContinuousStats{};
      continuous_row_for_ip(ip);
      update_continuous_row(ip);
    }
  };

  std::function<void(std::function<void(QStringList)>)> fetch_discovered_ips =
      [&](std::function<void(QStringList)> done) {
        request_json(network, "GET", origin + "/api/cameras", {}, continuous_log,
                     [&, done = std::move(done)](const QJsonObject& json) {
                       QStringList ips;
                       const QJsonArray cameras = json.value("cameras").toArray();
                       for (const QJsonValue& value : cameras) {
                         const QJsonObject camera = value.toObject();
                         const QString ip = camera.value("ip").toString().trimmed();
                         if (ip.isEmpty() || ips.contains(ip)) {
                           continue;
                         }
                         ips.append(ip);
                         const int row = find_or_add_row(camera_table, ip);
                         set_cell(camera_table, row, 1, camera.value("model").toString());
                         set_cell(camera_table, row, 2, camera.value("sn").toString());
                         set_cell(camera_table, row, 3, camera.value("driverId").toString());
                         set_cell(camera_table, row, 7, zh(u8"已发现"));
                         apply_camera_row_style(row, false, false, "discovered");
                       }
                       update_camera_selection_markers();
                       if (ips.size() < expected_camera_count->value()) {
                         continuous_log_line(QString(zh(u8"发现相机 %1 台，少于期望 %2 台。"))
                                                 .arg(ips.size())
                                                 .arg(expected_camera_count->value()));
                       } else {
                         continuous_log_line(QString(zh(u8"发现相机 %1 台。")).arg(ips.size()));
                       }
                       done(ips);
                     });
      };

  auto refresh_preview_meta = [&]() {
    const QString fid = QString::number(stream_status.value("fid").toInt(-1));
    const QString size = QString("%1 x %2")
                             .arg(stream_status.value("width").toInt())
                             .arg(stream_status.value("lines").toInt());
    const QString fps = QString("%1 / 限制 %2")
                            .arg(measured_fps, 0, 'f', 1)
                            .arg(stream_status.value("fpsLimit").toInt());
    const QString lost = QString::number(stream_status.value("lostLines").toInt());
    const QString temp = selected_status.contains("temperatureJ28")
                             ? QString("J28 %1 / J29 %2 / J30 %3")
                                   .arg(selected_status.value("temperatureJ28").toInt())
                                   .arg(selected_status.value("temperatureJ29").toInt())
                                   .arg(selected_status.value("temperatureJ30").toInt())
                             : QString("-");
    const QString interval = QString("%1 - %2")
                                 .arg(stream_status.value("triggerMinInterval").toInt())
                                 .arg(stream_status.value("triggerMaxInterval").toInt());
    preview_meta->setText(QString(zh(u8"帧号 %1 | 尺寸 %2 | FPS %3 | 丢线 %4 | 温度 %5 | 触发间隔 %6"))
                              .arg(fid, size, fps, lost, temp, interval));
  };

  auto render_status_panel = [&](const QJsonObject& status) {
    if (status.isEmpty()) {
      set_value(status_ip, "-");
      set_value(status_connection, "-");
      set_value(status_acquisition, "-");
      set_value(status_stream, "-");
      set_value(status_frames, "-");
      set_value(status_sdk, "-");
      set_value(status_link, "-");
      set_value(status_temperature, "-");
      set_value(status_errors, "-");
      set_value(status_identity, "-");
      return;
    }
    const bool connected = status.value("connected").toBool();
    const bool streaming = status.value("streamRunning").toBool();
    set_value(status_ip, status.value("ip").toString());
    set_value(status_connection, connected ? zh(u8"已连接") : zh(u8"未连接"));
    set_value(status_acquisition, status.value("acquisitionState").toString());
    set_value(status_stream, streaming ? zh(u8"实时预览中") : zh(u8"未预览"));
    set_value(status_frames, QString::number(status.value("streamFrames").toInt()));
    set_value(status_sdk, status.value("sdkStatus").toString());
    set_value(status_link, QString("%1%").arg(status.value("linkHealth").toInt()));
    set_value(status_temperature,
              QString("J28 %1 / J29 %2 / J30 %3")
                  .arg(status.value("temperatureJ28").toDouble(), 0, 'f', 1)
                  .arg(status.value("temperatureJ29").toDouble(), 0, 'f', 1)
                  .arg(status.value("temperatureJ30").toDouble(), 0, 'f', 1));
    set_value(status_errors,
              QString(zh(u8"丢脉冲 %1 / 缓冲溢出 %2"))
                  .arg(status.value("lostPulseCounter").toInt())
                  .arg(status.value("bufferOverflowCounter").toInt()));
    set_value(status_identity,
              QString("%1 | %2 | %3")
                  .arg(status.value("driverId").toString())
                  .arg(status.value("model").toString())
                  .arg(status.value("sn").toString()));
  };

  auto render_calibration_panel = [&](const QJsonObject& json) {
    if (json.isEmpty()) {
      set_value(calibration_code, "-");
      set_value(calibration_path_value, "-");
      set_value(roi_code, "-");
      set_value(roi_path_value, "-");
      set_value(calibration_time, "-");
      return;
    }
    if (json.contains("error")) {
      set_value(calibration_code, json.value("error").toString());
      set_value(calibration_path_value, "-");
      set_value(roi_code, "-");
      set_value(roi_path_value, "-");
      set_value(calibration_time, "-");
      return;
    }
    set_value(calibration_code, QString::number(json.value("calibrationCode").toInt()));
    set_value(calibration_path_value, json.value("calibrationPath").toString());
    set_value(roi_code, QString::number(json.value("roiCode").toInt()));
    set_value(roi_path_value, json.value("roiPath").toString());
    const QString time_text = json.value("calibrationTime").toString();
    const QString roi_time_text = json.value("roiTime").toString();
    set_value(calibration_time, time_text.isEmpty() ? roi_time_text : time_text);
  };

  std::function<void()> refresh_health = [&]() {
    request_json(network, "GET", origin + "/health", {}, log, [&](const QJsonObject& json) {
      const QString driver_mode = json.value("driverMode").toString("lvm");
      const QString driver_label = driver_mode == "simulated" ? zh(u8"离线模拟") : zh(u8"真实 SDK");
      api_state->setText(QString(zh(u8"采集 API：%1 | 模式：%2 | SDK：%3（%4）| 已连接：%5"))
                             .arg(origin)
                             .arg(driver_label)
                             .arg(json.value("sdkReady").toBool() ? zh(u8"就绪") : zh(u8"未就绪"))
                             .arg(json.value("sdkCode").toInt())
                             .arg(json.value("cameraCount").toInt()));
      provider_hint->setText(QString(zh(u8"Rust provider：qt-terminal | 驱动：%1")).arg(json.value("driverId").toString()));
      if (json.contains("storageRoot") && storage_root->text().trimmed().isEmpty()) {
        storage_root->setText(json.value("storageRoot").toString());
      }
    });
  };

  std::function<void()> refresh_storage = [&]() {
    request_json(network, "GET", origin + "/api/storage/status", {}, log, [&](const QJsonObject& json) {
      if (json.contains("root")) {
        storage_root->setText(json.value("root").toString());
      }
      storage_status_text->setPlainText(json_to_text(json));
    });
  };

  std::function<void()> refresh_config_status = [&]() {
    request_json(network, "GET", origin + "/api/config/status", {}, log, [&](const QJsonObject& json) {
      profile_result->setPlainText(json_to_text(json));
      render_profile_entries(json);
      const QString active = json.value("activeProfile").toString();
      if (!active.isEmpty()) {
        profile_name->setText(active);
        request_json(network, "GET", origin + "/api/config/profile?name=" + encoded(active), {}, log,
                     [&](const QJsonObject& profile) {
                       render_profile_object(profile);
                     });
      } else if (profile_json->toPlainText().trimmed().isEmpty()) {
        render_profile_object(build_profile_object());
      }
    });
  };

  std::function<void()> refresh_cameras = [&]() {
    request_json(network, "GET", origin + "/api/cameras", {}, log, [&](const QJsonObject& json) {
      const QJsonArray cameras = json.value("cameras").toArray();
      for (const QJsonValue& value : cameras) {
        const QJsonObject camera = value.toObject();
        const QString ip = camera.value("ip").toString();
        if (ip.isEmpty()) {
          continue;
        }
        const int row = find_or_add_row(camera_table, ip);
        set_cell(camera_table, row, 1, camera.value("model").toString());
        set_cell(camera_table, row, 2, camera.value("sn").toString());
        set_cell(camera_table, row, 3, camera.value("driverId").toString());
        set_cell(camera_table, row, 7, zh(u8"已发现"));
        apply_camera_row_style(row, false, false, "discovered");
      }
      update_camera_selection_markers();
    });
  };

  std::function<void()> refresh_statuses = [&]() {
    request_json(network, "GET", origin + "/api/camera/statuses", {}, log, [&](const QJsonObject& json) {
      const QJsonArray statuses = json.value("statuses").toArray();
      for (const QJsonValue& value : statuses) {
        const QJsonObject status = value.toObject();
        const QString ip = status.value("ip").toString();
        if (ip.isEmpty()) {
          continue;
        }
        const int row = find_or_add_row(camera_table, ip);
        set_cell(camera_table, row, 1, status.value("model").toString());
        set_cell(camera_table, row, 2, status.value("sn").toString());
        set_cell(camera_table, row, 3, status.value("driverId").toString());
        set_cell(camera_table, row, 4, status.value("connected").toBool() ? zh(u8"已连接") : zh(u8"未连接"));
        set_cell(camera_table, row, 5, status.value("sdkStatus").toString());
        set_cell(camera_table, row, 6, QString::number(status.value("streamFrames").toInt()));
        set_cell(camera_table, row, 7, status.value("streamRunning").toBool() ? zh(u8"实时预览") : status.value("acquisitionState").toString());
        apply_camera_row_style(row, status.value("connected").toBool(), status.value("streamRunning").toBool(), status.value("acquisitionState").toString());
        if (ip == selected_ip(camera_table)) {
          selected_status = status;
          render_status_panel(status);
        }
      }
      update_camera_selection_markers();
      refresh_preview_meta();
    });
  };

  std::function<void()> refresh_stream_status = [&]() {
    const QString ip = selected_ip(camera_table);
    if (ip.isEmpty()) {
      return;
    }
    request_json(network, "GET", origin + "/api/stream/status?ip=" + encoded(ip), {}, log, [&](const QJsonObject& json) {
      if (json.contains("error")) {
        if (!active_stream_ip.isEmpty()) {
          log_line(log, zh(u8"实时流状态错误：") + json.value("error").toString());
        }
        return;
      }
      const int frame_count = json.value("frameCount").toInt();
      const qint64 now_ms = QDateTime::currentMSecsSinceEpoch();
      if (last_fps_sample_ms > 0 && now_ms > last_fps_sample_ms && frame_count >= last_frame_count) {
        measured_fps = (frame_count - last_frame_count) * 1000.0 / static_cast<double>(now_ms - last_fps_sample_ms);
      }
      last_frame_count = frame_count;
      last_fps_sample_ms = now_ms;
      stream_status = json;
      refresh_preview_meta();
    });
  };

  std::function<void()> refresh_calibration_status = [&]() {
    const QString ip = selected_ip(camera_table);
    if (ip.isEmpty()) {
      return;
    }
    request_json(network, "GET", origin + "/api/calibration/status?ip=" + encoded(ip), {}, log, [&](const QJsonObject& json) {
      if (json.contains("error")) {
        render_calibration_panel(json);
        return;
      }
      render_calibration_panel(json);
      calibration_log->setPlainText(json_to_text(json));
    });
  };

  std::function<void()> refresh_all = [&]() {
    refresh_health();
    refresh_storage();
    refresh_config_status();
    refresh_cameras();
    refresh_statuses();
    refresh_stream_status();
    refresh_calibration_status();
  };

  std::function<void(QStringList, int, std::function<void(QStringList)>)> connect_ips_sequential;
  connect_ips_sequential = [&](QStringList ips, int index, std::function<void(QStringList)> done) {
    if (index >= ips.size()) {
      refresh_all();
      done(ips);
      return;
    }
    const QString ip = ips.at(index);
    continuous_stats[ip].connection = zh(u8"连接中");
    update_continuous_row(ip);
    request_json(network, "POST", origin + "/api/camera/connect", QJsonObject{{"ip", ip}, {"devType", -1}}, continuous_log,
                 [&, ips, index, done = std::move(done), ip](const QJsonObject& json) mutable {
                   const int code = json_code(json);
                   continuous_stats[ip].connection = code == 0 ? zh(u8"已连接") : zh(u8"失败");
                   continuous_stats[ip].last_code = code;
                   update_continuous_row(ip);
                   continuous_log_line(QString(zh(u8"自动连接 %1，返回码 %2")).arg(ip).arg(code));
                   connect_ips_sequential(ips, index + 1, std::move(done));
                 });
  };

  std::function<void(QStringList, std::function<void(QStringList)>)> connect_selected_ips =
      [&](QStringList ips, std::function<void(QStringList)> done) {
        if (ips.isEmpty()) {
          continuous_log_line(zh(u8"没有可连接的相机。"));
          done(ips);
          return;
        }
        reset_continuous_table(ips);
        connect_ips_sequential(ips, 0, std::move(done));
      };

  std::function<void(std::function<void(QStringList)>)> auto_connect_discovered =
      [&](std::function<void(QStringList)> done) {
        fetch_discovered_ips([&, done = std::move(done)](QStringList ips) mutable {
          connect_selected_ips(ips, std::move(done));
        });
      };

  auto stop_stream_for_ip = [&](const QString& ip, bool log_result) {
    if (ip.isEmpty()) {
      return;
    }
    request_json(network, "POST", origin + "/api/stream/stop", QJsonObject{{"ip", ip}}, log,
                 [&, ip, log_result](const QJsonObject& json) {
                   if (log_result) {
                     log_line(log, QString(zh(u8"停止预览 %1，返回码 %2")).arg(ip).arg(json_code(json)));
                   }
                   if (active_stream_ip == ip) {
                     active_stream_ip.clear();
                     preview_timer->stop();
                   }
                   stream_status = json;
                   refresh_preview_meta();
                   refresh_statuses();
                 });
  };

  auto set_selection_ip = [&](const QString& ip) {
    selected_label->setText(ip.isEmpty() ? zh(u8"未选择相机") : zh(u8"当前相机：") + ip);
    selected_status = {};
    stream_status = {};
    render_status_panel({});
    render_calibration_panel({});
    update_camera_selection_markers();
    measured_fps = 0.0;
    last_frame_count = 0;
    last_fps_sample_ms = 0;
    latest_preview_bytes.clear();
    preview->setText(ip.isEmpty() ? zh(u8"选择并连接一台相机后启动实时预览") : zh(u8"等待预览启动"));
    refresh_preview_meta();
  };

  auto show_preview_payload = [&](const QByteArray& payload) {
    QPixmap pixmap;
    if (!pixmap.loadFromData(payload)) {
      return;
    }
    latest_preview_bytes = payload;
    preview->setPixmap(pixmap.scaled(preview->size(), Qt::KeepAspectRatio, Qt::SmoothTransformation));
  };

  auto display_api_image = [&](QString image_url) {
    image_url = image_url.trimmed();
    if (image_url.isEmpty()) {
      return;
    }
    if (image_url.startsWith('/')) {
      image_url = origin + image_url;
    }
    request_image(network, image_url + (image_url.contains('?') ? "&" : "?") +
                             "t=" + QString::number(QDateTime::currentMSecsSinceEpoch()),
                  show_preview_payload);
  };

  QObject::connect(open_api, &QPushButton::clicked, [&]() {
    QDesktopServices::openUrl(QUrl(origin + "/ui"));
  });

  auto set_main_page = [&](int index) {
    main_stack->setCurrentIndex(index);
    preview_page_button->setEnabled(index != 0);
    config_page_button->setEnabled(index != 1);
  };
  QObject::connect(preview_page_button, &QPushButton::clicked, [&]() {
    set_main_page(0);
  });
  QObject::connect(config_page_button, &QPushButton::clicked, [&]() {
    set_main_page(1);
    refresh_config_status();
  });
  set_main_page(0);

  auto selected_profile_name = [&]() -> QString {
    const int row = profile_manage_table->currentRow();
    if (row < 0 || !profile_manage_table->item(row, 0)) {
      log_line(log, zh(u8"请先选择一个配置组。"));
      return {};
    }
    return profile_manage_table->item(row, 0)->text().trimmed();
  };

  auto apply_profile_by_name = [&](const QString& name, bool auto_connect) {
    if (name.trimmed().isEmpty()) {
      return;
    }
    request_json(network, "POST", origin + "/api/config/profile/apply",
                 QJsonObject{{"name", name.trimmed()}, {"autoConnect", auto_connect}},
                 log,
                 [&, name](const QJsonObject& json) {
                   profile_result->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"配置已应用/设为默认：%1，返回码 %2")).arg(name).arg(json_code(json)));
                   refresh_all();
                 });
  };

  QObject::connect(profile_apply_selected, &QPushButton::clicked, [&]() {
    const QString name = selected_profile_name();
    if (!name.isEmpty()) {
      apply_profile_by_name(name, true);
    }
  });
  QObject::connect(profile_refresh_list, &QPushButton::clicked, refresh_config_status);

  QObject::connect(profile_manage_table, &QTableWidget::itemSelectionChanged, [&]() {
    const int row = profile_manage_table->currentRow();
    const QString name = row >= 0 && profile_manage_table->item(row, 0) ? profile_manage_table->item(row, 0)->text().trimmed() : QString();
    if (name.isEmpty()) {
      return;
    }
    request_json(network, "GET", origin + "/api/config/profile?name=" + encoded(name), {}, log,
                 [&, name](const QJsonObject& profile) {
                   render_profile_object(profile);
                   log_line(log, QString(zh(u8"已选择配置：%1")).arg(name));
                 });
  });

  auto import_profile_path = [&](const QString& path) {
    if (path.trimmed().isEmpty()) {
      return;
    }
    QFileInfo info(path);
    const QString name = info.isDir() ? info.fileName() : info.completeBaseName();
    QJsonObject body{{"path", path}, {"name", name}, {"makeActive", true}, {"overwrite", false}};
    request_json(network, "POST", origin + "/api/config/profile/import", body, log,
                 [&, path, name](const QJsonObject& json) {
                   if (json_code(json) == 409) {
                     if (QMessageBox::question(&window, zh(u8"覆盖配置"), zh(u8"同名配置已存在，是否覆盖导入？")) == QMessageBox::Yes) {
                       request_json(network, "POST", origin + "/api/config/profile/import",
                                    QJsonObject{{"path", path}, {"name", name}, {"makeActive", true}, {"overwrite", true}},
                                    log,
                                    [&](const QJsonObject& overwrite_json) {
                                      profile_result->setPlainText(json_to_text(overwrite_json));
                                      log_line(log, QString(zh(u8"配置导入完成，返回码 %1")).arg(json_code(overwrite_json)));
                                      refresh_config_status();
                                    });
                     }
                     return;
                   }
                   profile_result->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"配置导入完成，返回码 %1")).arg(json_code(json)));
                   refresh_config_status();
                 });
  };

  QObject::connect(profile_import_folder, &QPushButton::clicked, [&]() {
    const QString base = QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation);
    const QString path = QFileDialog::getExistingDirectory(&window, zh(u8"选择配置组文件夹"), base);
    import_profile_path(path);
  });

  QObject::connect(profile_import_json, &QPushButton::clicked, [&]() {
    const QString base = QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation);
    const QString path = QFileDialog::getOpenFileName(&window, zh(u8"选择配置 JSON"), base, "JSON (*.json)");
    import_profile_path(path);
  });

  QObject::connect(profile_new_wizard, &QPushButton::clicked, [&]() {
    QDialog dialog(&window);
    dialog.setWindowTitle(zh(u8"新建采集配置"));
    auto* layout = new QVBoxLayout(&dialog);
    auto* form = new QFormLayout();
    auto* wizard_name = new QLineEdit("offline-sim");
    auto* wizard_driver = new QComboBox();
    wizard_driver->addItem(zh(u8"离线模拟"), "simulated");
    wizard_driver->addItem(zh(u8"真实 SDK"), "lvm");
    auto* wizard_camera_count = new QSpinBox();
    wizard_camera_count->setRange(1, 24);
    wizard_camera_count->setValue(profile_expected_cameras->value());
    auto* wizard_storage = new QLineEdit(storage_root->text().trimmed().isEmpty() ? "E:/steel-capture-data" : storage_root->text().trimmed());
    auto* wizard_storage_browse = new QPushButton(zh(u8"选择"));
    auto* wizard_storage_row = new QHBoxLayout();
    wizard_storage_row->addWidget(wizard_storage, 1);
    wizard_storage_row->addWidget(wizard_storage_browse);
    auto* wizard_sim_images = new QLineEdit();
    auto* wizard_sim_images_browse = new QPushButton(zh(u8"选择"));
    auto* wizard_sim_images_row = new QHBoxLayout();
    wizard_sim_images_row->addWidget(wizard_sim_images, 1);
    wizard_sim_images_row->addWidget(wizard_sim_images_browse);
    auto* wizard_auto_connect = new QCheckBox(zh(u8"应用后自动连接"));
    wizard_auto_connect->setChecked(true);
    auto* wizard_make_default = new QCheckBox(zh(u8"设为默认加载"));
    wizard_make_default->setChecked(true);
    form->addRow(zh(u8"配置名称"), wizard_name);
    form->addRow(zh(u8"运行模式"), wizard_driver);
    form->addRow(zh(u8"相机数量"), wizard_camera_count);
    form->addRow(zh(u8"图像保存位置"), wizard_storage_row);
    form->addRow(zh(u8"模拟图片目录"), wizard_sim_images_row);
    form->addRow(wizard_auto_connect);
    form->addRow(wizard_make_default);
    layout->addLayout(form);
    auto* buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
    layout->addWidget(buttons);
    QObject::connect(wizard_storage_browse, &QPushButton::clicked, [&]() {
      const QString path = QFileDialog::getExistingDirectory(&dialog, zh(u8"选择图像保存位置"), wizard_storage->text());
      if (!path.isEmpty()) {
        wizard_storage->setText(path);
      }
    });
    QObject::connect(wizard_sim_images_browse, &QPushButton::clicked, [&]() {
      const QString path = QFileDialog::getExistingDirectory(&dialog, zh(u8"选择模拟图片目录"), wizard_sim_images->text());
      if (!path.isEmpty()) {
        wizard_sim_images->setText(path);
      }
    });
    QObject::connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    QObject::connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() != QDialog::Accepted) {
      return;
    }

    const QString name = wizard_name->text().trimmed().isEmpty() ? "default" : wizard_name->text().trimmed();
    const QJsonObject profile{
        {"schema", "steel.capture.profile.v1"},
        {"name", name},
        {"updatedAt", QDateTime::currentDateTime().toString(Qt::ISODateWithMs)},
        {"driverMode", wizard_driver->currentData().toString()},
        {"storageRoot", wizard_storage->text().trimmed()},
        {"startupMode", wizard_auto_connect->isChecked() ? "auto-connect" : "manual"},
        {"autoConnect", wizard_auto_connect->isChecked()},
        {"expectedCameras", wizard_camera_count->value()},
        {"changeStorage", true},
        {"applySoftTrigger", true},
        {"loadCameraParams", false},
        {"saveToDevice", false},
        {"lines", lines->value()},
        {"width", width->value()},
        {"timeoutMs", timeout_ms->value()},
        {"dataMode", data_mode->currentData().toInt()},
        {"fpsLimit", fps_limit->value()},
        {"timeTriggerFreq", trigger_freq->value()},
        {"exposureTime", exposure->value()},
        {"gainK", gain->value()},
        {"simulated", QJsonObject{{"imageSourceDir", wizard_sim_images->text().trimmed()}}},
        {"cameras", QJsonArray{}},
    };
    const QJsonObject body{
        {"name", name},
        {"makeActive", wizard_make_default->isChecked()},
        {"profileJson", QString::fromUtf8(QJsonDocument(profile).toJson(QJsonDocument::Compact))},
    };
    request_json(network, "POST", origin + "/api/config/profile/save", body, log,
                 [&, name, profile, auto_connect = wizard_auto_connect->isChecked(), make_default = wizard_make_default->isChecked()](const QJsonObject& json) {
                   profile_result->setPlainText(json_to_text(json));
                   render_profile_object(profile);
                   log_line(log, QString(zh(u8"配置向导已保存：%1，返回码 %2")).arg(name).arg(json_code(json)));
                   if (make_default) {
                     apply_profile_by_name(name, auto_connect);
                   } else {
                     refresh_config_status();
                   }
                 });
  });

  QObject::connect(storage_browse, &QPushButton::clicked, [&]() {
    const QString path = QFileDialog::getExistingDirectory(&window, zh(u8"选择数据存储目录"), storage_root->text());
    if (!path.isEmpty()) {
      storage_root->setText(path);
    }
  });

  QObject::connect(storage_refresh, &QPushButton::clicked, refresh_storage);

  QObject::connect(storage_open, &QPushButton::clicked, [&]() {
    const QString root_path = storage_root->text().trimmed();
    if (root_path.isEmpty()) {
      log_line(log, zh(u8"存储目录不能为空。"));
      return;
    }
    QDir().mkpath(root_path);
    QDesktopServices::openUrl(QUrl::fromLocalFile(root_path));
  });

  QObject::connect(storage_apply, &QPushButton::clicked, [&]() {
    const QString root_path = storage_root->text().trimmed();
    if (root_path.isEmpty()) {
      log_line(log, zh(u8"存储目录不能为空。"));
      return;
    }
    request_json(network, "POST", origin + "/api/storage/config", QJsonObject{{"root", root_path}}, log,
                 [&](const QJsonObject& json) {
                   storage_status_text->setPlainText(json_to_text(json));
                   if (json.contains("root")) {
                     storage_root->setText(json.value("root").toString());
                   }
                   log_line(log, QString(zh(u8"存储目录已更新：%1")).arg(storage_root->text()));
                 });
  });

  QObject::connect(profile_param_dir_browse, &QPushButton::clicked, [&]() {
    const QString base = storage_root->text().trimmed().isEmpty() ? QDir::currentPath() : storage_root->text().trimmed();
    const QString path = QFileDialog::getExistingDirectory(&window, zh(u8"选择相机参数文件夹"), base);
    if (!path.isEmpty()) {
      profile_camera_param_dir->setText(path);
    }
  });

  auto load_profile_camera_editor = [&]() {
    const int row = profile_camera_table->currentRow();
    if (row < 0) {
      return;
    }
    edit_camera_ip->setText(profile_camera_table->item(row, 0) ? profile_camera_table->item(row, 0)->text() : "");
    const QString enabled_text = profile_camera_table->item(row, 1) ? profile_camera_table->item(row, 1)->text().trimmed() : zh(u8"是");
    edit_camera_enabled->setChecked(enabled_text != zh(u8"否") && enabled_text != "false" && enabled_text != "0");
    edit_camera_model->setText(profile_camera_table->item(row, 2) ? profile_camera_table->item(row, 2)->text() : "");
    edit_camera_sn->setText(profile_camera_table->item(row, 3) ? profile_camera_table->item(row, 3)->text() : "");
    edit_camera_param_file->setText(profile_camera_table->item(row, 4) ? profile_camera_table->item(row, 4)->text() : "");
    int camera_exposure = profile_camera_table->item(row, 5) ? profile_camera_table->item(row, 5)->text().toInt() : exposure->value();
    if (camera_exposure < 1) {
      camera_exposure = exposure->value();
    }
    edit_camera_exposure->setValue(camera_exposure);
    edit_camera_gain->setValue(profile_camera_table->item(row, 6) ? profile_camera_table->item(row, 6)->text().toDouble() : gain->value());
    edit_camera_trigger_freq->setValue(profile_camera_table->item(row, 7) ? profile_camera_table->item(row, 7)->text().toDouble() : trigger_freq->value());
  };

  QObject::connect(profile_camera_table, &QTableWidget::itemSelectionChanged, load_profile_camera_editor);

  QObject::connect(edit_camera_param_browse, &QPushButton::clicked, [&]() {
    const QString ip = edit_camera_ip->text().trimmed();
    const QString base = edit_camera_param_file->text().trimmed().isEmpty() ? camera_param_path_for_ip(ip) : edit_camera_param_file->text().trimmed();
    const QString path = QFileDialog::getSaveFileName(&window, zh(u8"选择相机参数文件"), base, "NCCFG (*.nccfg);;All Files (*.*)");
    if (!path.isEmpty()) {
      edit_camera_param_file->setText(path);
    }
  });

  QObject::connect(profile_camera_sync, &QPushButton::clicked, [&]() {
    for (int row = 0; row < camera_table->rowCount(); ++row) {
      const QString ip = camera_table->item(row, 0) ? camera_table->item(row, 0)->text().trimmed() : QString();
      if (ip.isEmpty()) {
        continue;
      }
      set_profile_camera_row(profile_camera_row_for_ip(ip),
                             QJsonObject{
                                 {"ip", ip},
                                 {"enabled", true},
                                 {"model", camera_table->item(row, 1) ? camera_table->item(row, 1)->text() : ""},
                                 {"sn", camera_table->item(row, 2) ? camera_table->item(row, 2)->text() : ""},
                                 {"paramFile", camera_param_path_for_ip(ip)},
                                 {"params", QJsonObject{
                                                {"exposureTime", exposure->value()},
                                                {"gainK", gain->value()},
                                                {"timeTriggerFreq", trigger_freq->value()},
                                            }},
                             });
    }
    render_profile_object(build_profile_object());
    log_line(log, zh(u8"已从当前相机列表同步相机配置。"));
  });

  QObject::connect(profile_camera_update, &QPushButton::clicked, [&]() {
    const QJsonObject camera = current_profile_camera_object();
    const QString ip = camera.value("ip").toString();
    if (ip.isEmpty()) {
      log_line(log, zh(u8"相机 IP 不能为空。"));
      return;
    }
    set_profile_camera_row(profile_camera_row_for_ip(ip), camera);
    render_profile_object(build_profile_object());
    log_line(log, QString(zh(u8"相机配置已更新：%1")).arg(ip));
  });

  QObject::connect(profile_camera_delete, &QPushButton::clicked, [&]() {
    const int row = profile_camera_table->currentRow();
    if (row < 0) {
      log_line(log, zh(u8"请先选择一条相机配置。"));
      return;
    }
    const QString ip = profile_camera_table->item(row, 0) ? profile_camera_table->item(row, 0)->text() : "";
    profile_camera_table->removeRow(row);
    render_profile_object(build_profile_object());
    log_line(log, QString(zh(u8"相机配置已删除：%1")).arg(ip));
  });

  QObject::connect(profile_camera_write_profile, &QPushButton::clicked, [&]() {
    render_profile_object(build_profile_object());
    profile_result->setPlainText(zh(u8"{\n  \"code\": 0,\n  \"message\": \"相机配置已写入配置 JSON，保存后生效\"\n}"));
  });

  QObject::connect(profile_refresh, &QPushButton::clicked, refresh_config_status);

  QObject::connect(profile_generate, &QPushButton::clicked, [&]() {
    render_profile_object(build_profile_object());
    profile_result->setPlainText(zh(u8"{\n  \"code\": 0,\n  \"message\": \"已根据当前界面生成配置 JSON\"\n}"));
  });

  QObject::connect(profile_save, &QPushButton::clicked, [&]() {
    QJsonObject profile = profile_object_from_editor();
    if (profile.isEmpty()) {
      return;
    }
    const QString name = profile.value("name").toString(profile_name->text().trimmed());
    const QJsonObject body{
        {"name", name.isEmpty() ? "default" : name},
        {"makeActive", true},
        {"profileJson", QString::fromUtf8(QJsonDocument(profile).toJson(QJsonDocument::Compact))},
    };
    request_json(network, "POST", origin + "/api/config/profile/save", body, log,
                 [&](const QJsonObject& json) {
                   profile_result->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"配置文件已保存：%1，返回码 %2"))
                                     .arg(json.value("name").toString())
                                     .arg(json_code(json)));
                   refresh_config_status();
                 });
  });

  QObject::connect(profile_apply, &QPushButton::clicked, [&]() {
    QJsonObject profile = profile_object_from_editor();
    if (profile.isEmpty()) {
      return;
    }
    const QString name = profile.value("name").toString(profile_name->text().trimmed());
    const QJsonObject body{
        {"name", name.isEmpty() ? "default" : name},
        {"profileJson", QString::fromUtf8(QJsonDocument(profile).toJson(QJsonDocument::Compact))},
        {"autoConnect", profile_auto_connect->isChecked()},
        {"loadCameraParams", profile_load_camera_params->isChecked()},
        {"saveToDevice", profile_save_to_device->isChecked()},
        {"changeStorage", profile_change_storage->isChecked()},
        {"expectedCameras", profile_expected_cameras->value()},
    };
    request_json(network, "POST", origin + "/api/config/profile/apply", body, log,
                 [&](const QJsonObject& json) {
                   profile_result->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"配置已应用：%1，返回码 %2"))
                                     .arg(json.value("name").toString())
                                     .arg(json_code(json)));
                   refresh_all();
                 });
  });

  QObject::connect(profile_save_camera_params, &QPushButton::clicked, [&]() {
    const QJsonObject body{
        {"name", profile_name->text().trimmed().isEmpty() ? "default" : profile_name->text().trimmed()},
        {"cameraParamDir", profile_camera_param_dir->text().trimmed()},
        {"applySoftTrigger", true},
        {"saveToDevice", profile_save_to_device->isChecked()},
    };
    request_json(network, "POST", origin + "/api/config/camera-params/save-all", body, log,
                 [&](const QJsonObject& json) {
                   profile_result->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"全部相机参数文件保存完成，返回码 %1")).arg(json_code(json)));
                 });
  });

  QObject::connect(profile_load_camera_params_button, &QPushButton::clicked, [&]() {
    const QJsonObject body{
        {"name", profile_name->text().trimmed().isEmpty() ? "default" : profile_name->text().trimmed()},
        {"cameraParamDir", profile_camera_param_dir->text().trimmed()},
        {"applySoftTrigger", true},
        {"saveToDevice", profile_save_to_device->isChecked()},
    };
    request_json(network, "POST", origin + "/api/config/camera-params/load-all", body, log,
                 [&](const QJsonObject& json) {
                   profile_result->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"全部相机参数文件加载完成，返回码 %1")).arg(json_code(json)));
                   refresh_all();
                 });
  });

  QObject::connect(refresh_button, &QPushButton::clicked, refresh_all);

  QObject::connect(auto_connect_button, &QPushButton::clicked, [&]() {
    auto_connect_discovered([&](QStringList) {
      continuous_log_line(zh(u8"自动连接流程完成。"));
      refresh_all();
    });
  });

  QObject::connect(camera_table, &QTableWidget::itemSelectionChanged, [&]() {
    if (selection_change_guard) {
      return;
    }
    const QString ip = selected_ip(camera_table);
    if (!active_stream_ip.isEmpty() && active_stream_ip != ip) {
      stop_stream_for_ip(active_stream_ip, true);
    }
    set_selection_ip(ip);
    refresh_statuses();
    refresh_stream_status();
    refresh_calibration_status();
  });

  QObject::connect(connect_button, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    if (ip.isEmpty()) {
      return;
    }
    request_json(network, "POST", origin + "/api/camera/connect", QJsonObject{{"ip", ip}, {"devType", -1}}, log,
                 [&, ip](const QJsonObject& json) {
                   log_line(log, QString(zh(u8"连接相机 %1，返回码 %2")).arg(ip).arg(json_code(json)));
                   refresh_all();
                 });
  });

  QObject::connect(disconnect_button, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    if (ip.isEmpty()) {
      return;
    }
    stop_stream_for_ip(ip, false);
    request_json(network, "POST", origin + "/api/camera/disconnect", QJsonObject{{"ip", ip}}, log,
                 [&, ip](const QJsonObject& json) {
                   log_line(log, QString(zh(u8"断开相机 %1，返回码 %2")).arg(ip).arg(json_code(json)));
                   if (active_stream_ip == ip) {
                     active_stream_ip.clear();
                     preview_timer->stop();
                   }
                   refresh_all();
                 });
  });

  QObject::connect(disconnect_all_button, &QPushButton::clicked, [&]() {
    if (!active_stream_ip.isEmpty()) {
      stop_stream_for_ip(active_stream_ip, false);
    }
    request_json(network, "POST", origin + "/api/camera/disconnect", {}, log, [&](const QJsonObject& json) {
      log_line(log, QString(zh(u8"全部断开，返回码 %1")).arg(json_code(json)));
      active_stream_ip.clear();
      preview_timer->stop();
      refresh_all();
    });
  });

  QObject::connect(start_stream, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    if (ip.isEmpty()) {
      return;
    }
    const QJsonObject body{
        {"ip", ip},
        {"lines", lines->value()},
        {"width", width->value()},
        {"dataMode", data_mode->currentData().toInt()},
        {"hs", high_speed->isChecked()},
        {"fpsLimit", fps_limit->value()},
    };
    request_json(network, "POST", origin + "/api/stream/start", body, log, [&, ip](const QJsonObject& json) {
      if (json.contains("error")) {
        log_line(log, QString(zh(u8"启动预览失败：%1（%2）")).arg(json.value("error").toString()).arg(json_code(json)));
        return;
      }
      active_stream_ip = ip;
      stream_status = json;
      last_frame_count = json.value("frameCount").toInt();
      last_fps_sample_ms = QDateTime::currentMSecsSinceEpoch();
      measured_fps = 0.0;
      preview->setText(zh(u8"等待第一帧..."));
      preview_timer->start();
      log_line(log, QString(zh(u8"启动预览 %1，尺寸 %2 x %3"))
                        .arg(ip)
                        .arg(json.value("width").toInt())
                        .arg(json.value("lines").toInt()));
      refresh_statuses();
      refresh_preview_meta();
    });
  });

  QObject::connect(stop_stream, &QPushButton::clicked, [&]() {
    const QString ip = active_stream_ip.isEmpty() ? selected_or_log() : active_stream_ip;
    if (ip.isEmpty()) {
      return;
    }
    stop_stream_for_ip(ip, true);
    preview->setText(zh(u8"预览已停止"));
  });

  QObject::connect(preview_timer, &QTimer::timeout, [&]() {
    if (active_stream_ip.isEmpty()) {
      return;
    }
    const QString kind = preview_kind->currentData().toString();
    const QString url = origin + "/api/stream/latest?ip=" + encoded(active_stream_ip) +
                        "&kind=" + encoded(kind) +
                        "&t=" + QString::number(QDateTime::currentMSecsSinceEpoch());
    request_image(network, url, show_preview_payload);
    refresh_stream_status();
  });

  QObject::connect(save_frame, &QPushButton::clicked, [&]() {
    if (latest_preview_bytes.isEmpty()) {
      log_line(log, zh(u8"当前还没有可保存的预览帧。"));
      return;
    }
    const QString base = storage_root->text().trimmed().isEmpty() ? QDir::currentPath() : storage_root->text().trimmed();
    const QString default_name = QDir(base).filePath("qt/current-preview.png");
    const QString path = QFileDialog::getSaveFileName(&window, zh(u8"保存当前帧"), default_name, "PNG (*.png)");
    if (path.isEmpty()) {
      return;
    }
    QDir().mkpath(QFileInfo(path).absolutePath());
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
      log_line(log, zh(u8"保存失败：") + file.errorString());
      return;
    }
    file.write(latest_preview_bytes);
    log_line(log, zh(u8"当前帧已保存：") + path);
  });

  auto capture_validation_frame = [&](bool write_calibration_record) {
    const QString ip = selected_or_log();
    if (ip.isEmpty()) {
      return;
    }

    std::function<void()> run_capture = [&, ip, write_calibration_record]() {
      QString output = write_calibration_record ? validation_output->text().trimmed() : QString();
      if (write_calibration_record && output.isEmpty()) {
        output = "calibration/validation.png";
      }
      if (write_calibration_record && output == "calibration/validation.png") {
        QString safe_ip = ip;
        safe_ip.replace('.', '_');
        output = QString("calibration/%1-validation.png").arg(safe_ip);
      }
      const QJsonObject body{
          {"ip", ip},
          {"lines", lines->value()},
          {"width", width->value()},
          {"dataMode", data_mode->currentData().toInt()},
          {"timeoutMs", timeout_ms->value()},
          {"output", output},
      };
      const QString endpoint = write_calibration_record ? "/api/capture/depth-map" : "/api/preview/capture";
      request_json(network, "POST", origin + endpoint, body, log,
                   [&, ip, output, write_calibration_record](const QJsonObject& json) {
                     calibration_log->setPlainText(json_to_text(json));
                     display_api_image(json.value("imageUrl").toString());
                     log_line(log, QString(write_calibration_record ? zh(u8"验证帧采集 %1，返回码 %2，输出 %3")
                                                                     : zh(u8"预览帧采集 %1，返回码 %2，输出 %3"))
                                        .arg(ip)
                                        .arg(json_code(json))
                                        .arg(json.value("output").toString(output)));
                     if (write_calibration_record) {
                       append_calibration_record(log,
                                                 QJsonObject{
                                                     {"time", QDateTime::currentDateTime().toString(Qt::ISODateWithMs)},
                                                     {"action", "validation-capture"},
                                                     {"ip", ip},
                                                     {"calibrationFile", calibration_path->text().trimmed()},
                                                     {"roiFile", roi_path->text().trimmed()},
                                                     {"returnCode", json_code(json)},
                                                     {"validationFrame", json.value("output").toString(output)},
                                                 });
                     }
                     refresh_calibration_status();
                   });
    };

    if (active_stream_ip == ip) {
      request_json(network, "POST", origin + "/api/stream/stop", QJsonObject{{"ip", ip}}, log,
                   [&, ip, run_capture](const QJsonObject& json) {
                     log_line(log, QString(zh(u8"验证前停止预览 %1，返回码 %2")).arg(ip).arg(json_code(json)));
                     if (active_stream_ip == ip) {
                       active_stream_ip.clear();
                       preview_timer->stop();
                     }
                     stream_status = json;
                     refresh_preview_meta();
                     run_capture();
                   });
      return;
    }

    run_capture();
  };

  std::function<void()> finish_continuous_test = [&]() {
    continuous_running = false;
    continuous_timer->stop();
    continuous_start->setEnabled(true);
    continuous_auto_connect->setEnabled(true);
    continuous_stop->setEnabled(false);
    if (continuous_round > continuous_rounds->value()) {
      continuous_round = continuous_rounds->value();
    }
    update_continuous_summary();
    continuous_log_line(QString(zh(u8"连续采集测试结束：尝试 %1，成功 %2，失败 %3。"))
                            .arg(continuous_total_attempts)
                            .arg(continuous_total_success)
                            .arg(continuous_total_failure));
    refresh_all();
  };

  std::function<void()> run_next_continuous_capture;
  run_next_continuous_capture = [&]() {
    if (!continuous_running) {
      return;
    }
    if (continuous_ips.isEmpty()) {
      continuous_log_line(zh(u8"连续采集测试没有可用相机。"));
      finish_continuous_test();
      return;
    }
    if (continuous_round > continuous_rounds->value()) {
      finish_continuous_test();
      return;
    }
    if (continuous_index >= continuous_ips.size()) {
      continuous_round += 1;
      continuous_index = 0;
      update_continuous_summary();
      if (continuous_round > continuous_rounds->value()) {
        finish_continuous_test();
        return;
      }
      continuous_timer->start(continuous_interval_ms->value());
      return;
    }

    const QString ip = continuous_ips.at(continuous_index);
    continuous_index += 1;
    ContinuousStats& stats = continuous_stats[ip];
    stats.attempts += 1;
    continuous_total_attempts += 1;
    update_continuous_row(ip);

    QString output_dir = continuous_output_dir->text().trimmed();
    if (output_dir.isEmpty()) {
      output_dir = "continuous-test";
    }
    output_dir.replace('\\', '/');
    while (output_dir.endsWith('/')) {
      output_dir.chop(1);
    }
    const QString output = QString("%1/%2/round-%3-shot-%4.png")
                               .arg(output_dir)
                               .arg(safe_file_ip(ip))
                               .arg(continuous_round, 3, 10, QLatin1Char('0'))
                               .arg(stats.attempts, 4, 10, QLatin1Char('0'));
    const QJsonObject body{
        {"ip", ip},
        {"lines", lines->value()},
        {"width", width->value()},
        {"dataMode", data_mode->currentData().toInt()},
        {"timeoutMs", timeout_ms->value()},
        {"output", output},
    };
    request_json(network, "POST", origin + "/api/capture/depth-map", body, continuous_log,
                 [&, ip, output](const QJsonObject& json) {
                   const int code = json_code(json);
                   ContinuousStats& item = continuous_stats[ip];
                   item.last_code = code;
                   item.latest_output = json.value("output").toString(output);
                   if (code == 0) {
                     item.successes += 1;
                     continuous_total_success += 1;
                   } else {
                     item.failures += 1;
                     continuous_total_failure += 1;
                   }
                   update_continuous_row(ip);
                   continuous_log_line(QString(zh(u8"连续采集 第 %1 轮 %2，返回码 %3，输出 %4"))
                                           .arg(continuous_round)
                                           .arg(ip)
                                           .arg(code)
                                           .arg(item.latest_output));
                   if (continuous_running) {
                     continuous_timer->start(continuous_interval_ms->value());
                   }
                 });
  };

  QObject::connect(continuous_timer, &QTimer::timeout, run_next_continuous_capture);

  auto begin_continuous_test = [&](QStringList ips) {
    if (ips.isEmpty()) {
      continuous_log_line(zh(u8"没有可测试的相机。"));
      continuous_start->setEnabled(true);
      continuous_auto_connect->setEnabled(true);
      continuous_stop->setEnabled(false);
      return;
    }
    continuous_ips = ips;
    continuous_round = 1;
    continuous_index = 0;
    continuous_total_attempts = 0;
    continuous_total_success = 0;
    continuous_total_failure = 0;
    for (const QString& ip : continuous_ips) {
      continuous_stats[ip].attempts = 0;
      continuous_stats[ip].successes = 0;
      continuous_stats[ip].failures = 0;
      continuous_stats[ip].latest_output.clear();
      update_continuous_row(ip);
    }
    continuous_running = true;
    continuous_start->setEnabled(false);
    continuous_auto_connect->setEnabled(false);
    continuous_stop->setEnabled(true);
    update_continuous_summary();
    continuous_log_line(QString(zh(u8"开始连续采集测试：%1 台相机，%2 轮。"))
                            .arg(continuous_ips.size())
                            .arg(continuous_rounds->value()));
    continuous_timer->start(0);
  };

  auto prepare_continuous_test = [&](std::function<void(QStringList)> done) {
    if (continuous_scope->currentData().toString() == "selected") {
      const QString ip = selected_or_log();
      if (ip.isEmpty()) {
        done({});
        return;
      }
      connect_selected_ips(QStringList{ip}, std::move(done));
      return;
    }
    auto_connect_discovered(std::move(done));
  };

  QObject::connect(continuous_output_browse, &QPushButton::clicked, [&]() {
    const QString path = QFileDialog::getExistingDirectory(&window, zh(u8"选择连续测试输出目录"), continuous_output_dir->text());
    if (!path.isEmpty()) {
      continuous_output_dir->setText(path);
    }
  });

  QObject::connect(continuous_auto_connect, &QPushButton::clicked, [&]() {
    auto_connect_discovered([&](QStringList) {
      continuous_log_line(zh(u8"连续测试页自动连接完成。"));
    });
  });

  QObject::connect(continuous_start, &QPushButton::clicked, [&]() {
    if (continuous_running) {
      return;
    }
    continuous_start->setEnabled(false);
    continuous_auto_connect->setEnabled(false);
    continuous_stop->setEnabled(true);
    auto start_after_stream_stopped = [&]() {
      prepare_continuous_test([&](QStringList ips) {
        begin_continuous_test(ips);
      });
    };
    if (!active_stream_ip.isEmpty()) {
      const QString stream_ip = active_stream_ip;
      request_json(network, "POST", origin + "/api/stream/stop", QJsonObject{{"ip", stream_ip}}, continuous_log,
                   [&, stream_ip, start_after_stream_stopped](const QJsonObject& json) {
                     continuous_log_line(QString(zh(u8"连续测试前停止预览 %1，返回码 %2")).arg(stream_ip).arg(json_code(json)));
                     if (active_stream_ip == stream_ip) {
                       active_stream_ip.clear();
                       preview_timer->stop();
                     }
                     stream_status = json;
                     refresh_preview_meta();
                     start_after_stream_stopped();
                   });
      return;
    }
    start_after_stream_stopped();
  });

  QObject::connect(continuous_stop, &QPushButton::clicked, [&]() {
    if (!continuous_running) {
      return;
    }
    continuous_running = false;
    continuous_timer->stop();
    continuous_start->setEnabled(true);
    continuous_auto_connect->setEnabled(true);
    continuous_stop->setEnabled(false);
    update_continuous_summary();
    continuous_log_line(zh(u8"连续采集测试已手动停止。"));
  });

  QObject::connect(stability_test_button, &QPushButton::clicked, [&]() {
    QDialog dialog(&window);
    dialog.setWindowTitle(zh(u8"采集稳定性测试"));
    auto* layout = new QVBoxLayout(&dialog);
    auto* form = new QFormLayout();
    auto* dialog_scope = new QComboBox();
    dialog_scope->addItem(zh(u8"全部已发现相机"), "all");
    dialog_scope->addItem(zh(u8"当前选中相机"), "selected");
    dialog_scope->setCurrentIndex(continuous_scope->currentIndex());
    auto* dialog_rounds = new QSpinBox();
    dialog_rounds->setRange(1, 10000);
    dialog_rounds->setValue(continuous_rounds->value());
    auto* dialog_interval = new QSpinBox();
    dialog_interval->setRange(0, 600000);
    dialog_interval->setValue(continuous_interval_ms->value());
    dialog_interval->setSuffix(" ms");
    auto* dialog_output = new QLineEdit(continuous_output_dir->text());
    auto* dialog_output_browse = new QPushButton(zh(u8"选择"));
    auto* dialog_output_row = new QHBoxLayout();
    dialog_output_row->addWidget(dialog_output, 1);
    dialog_output_row->addWidget(dialog_output_browse);
    form->addRow(zh(u8"测试范围"), dialog_scope);
    form->addRow(zh(u8"采集轮数"), dialog_rounds);
    form->addRow(zh(u8"间隔"), dialog_interval);
    form->addRow(zh(u8"输出目录"), dialog_output_row);
    layout->addLayout(form);
    auto* buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
    buttons->button(QDialogButtonBox::Ok)->setText(zh(u8"开始测试"));
    layout->addWidget(buttons);
    QObject::connect(dialog_output_browse, &QPushButton::clicked, [&]() {
      const QString path = QFileDialog::getExistingDirectory(&dialog, zh(u8"选择测试输出目录"), dialog_output->text());
      if (!path.isEmpty()) {
        dialog_output->setText(path);
      }
    });
    QObject::connect(buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    QObject::connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() != QDialog::Accepted) {
      return;
    }
    const int scope_index = continuous_scope->findData(dialog_scope->currentData());
    if (scope_index >= 0) {
      continuous_scope->setCurrentIndex(scope_index);
    }
    continuous_rounds->setValue(dialog_rounds->value());
    continuous_interval_ms->setValue(dialog_interval->value());
    continuous_output_dir->setText(dialog_output->text().trimmed().isEmpty() ? "continuous-test" : dialog_output->text().trimmed());
    set_main_page(0);
    camera_tabs->setCurrentWidget(continuous_tab);
    if (continuous_running) {
      continuous_log_line(zh(u8"已有采集稳定性测试正在运行。"));
      return;
    }
    continuous_start->click();
  });

  QObject::connect(capture_once, &QPushButton::clicked, [&]() {
    capture_validation_frame(false);
  });

  QObject::connect(apply_params, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    if (ip.isEmpty()) {
      return;
    }
    const std::vector<QJsonObject> params = {
        QJsonObject{{"ip", ip}, {"key", "ExposureTime"}, {"type", "int"}, {"value", exposure->value()}},
        QJsonObject{{"ip", ip}, {"key", "GainK"}, {"type", "float"}, {"value", gain->value()}},
        QJsonObject{{"ip", ip}, {"key", "TimeTriggerFreq"}, {"type", "float"}, {"value", trigger_freq->value()}},
        QJsonObject{{"ip", ip}, {"key", "TriggerMode"}, {"type", "int"}, {"value", 0}},
    };
    for (const QJsonObject& param : params) {
      request_json(network, "POST", origin + "/api/param", param, log, [&, param](const QJsonObject& json) {
        log_line(log, QString(zh(u8"参数 %1 写入返回码 %2"))
                          .arg(param.value("key").toString())
                          .arg(json_code(json)));
        param_result->setPlainText(json_to_text(json));
      });
    }
  });

  QObject::connect(enforce_soft_trigger, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    if (ip.isEmpty()) {
      return;
    }
    request_json(network,
                 "POST",
                 origin + "/api/param",
                 QJsonObject{{"ip", ip}, {"key", "TriggerMode"}, {"type", "int"}, {"value", 0}},
                 log,
                 [&](const QJsonObject& json) {
                   log_line(log, QString(zh(u8"软触发写入返回码 %1")).arg(json_code(json)));
                   param_result->setPlainText(json_to_text(json));
                 });
  });

  QObject::connect(read_param, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    if (ip.isEmpty()) {
      return;
    }
    const QString url = origin + "/api/param?ip=" + encoded(ip) +
                        "&key=" + encoded(param_key->text().trimmed()) +
                        "&type=" + encoded(param_type->currentData().toString());
    request_json(network, "GET", url, {}, log, [&](const QJsonObject& json) {
      param_result->setPlainText(json_to_text(json));
      if (json.contains("value")) {
        const QJsonValue value = json.value("value");
        param_value->setText(value.isString() ? value.toString() : QString::fromUtf8(QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact)).mid(1).chopped(1));
      }
    });
  });

  QObject::connect(write_param, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    if (ip.isEmpty()) {
      return;
    }
    const QString type = param_type->currentData().toString();
    QJsonValue value = param_value->text();
    if (type == "int") {
      value = param_value->text().toInt();
    } else if (type == "float") {
      value = param_value->text().toDouble();
    }
    request_json(network,
                 "POST",
                 origin + "/api/param",
                 QJsonObject{{"ip", ip}, {"key", param_key->text().trimmed()}, {"type", type}, {"value", value}},
                 log,
                 [&](const QJsonObject& json) {
                   param_result->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"参数 %1 写入返回码 %2")).arg(param_key->text().trimmed()).arg(json_code(json)));
                 });
  });

  QObject::connect(calibration_browse, &QPushButton::clicked, [&]() {
    const QString path = QFileDialog::getOpenFileName(&window, zh(u8"选择标定文件"));
    if (!path.isEmpty()) {
      calibration_path->setText(path);
    }
  });

  QObject::connect(roi_browse, &QPushButton::clicked, [&]() {
    const QString path = QFileDialog::getOpenFileName(&window, zh(u8"选择 ROI 文件"));
    if (!path.isEmpty()) {
      roi_path->setText(path);
    }
  });

  QObject::connect(calibration_apply, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    const QString path = calibration_path->text().trimmed();
    if (ip.isEmpty() || path.isEmpty()) {
      log_line(log, zh(u8"请选择相机和标定文件。"));
      return;
    }
    request_json(network, "POST", origin + "/api/calibration/load", QJsonObject{{"ip", ip}, {"path", path}}, log,
                 [&, ip, path](const QJsonObject& json) {
                   calibration_log->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"应用标定 %1，返回码 %2")).arg(ip).arg(json_code(json)));
                   append_calibration_record(log,
                                             QJsonObject{
                                                 {"time", QDateTime::currentDateTime().toString(Qt::ISODateWithMs)},
                                                 {"action", "calibration-load"},
                                                 {"ip", ip},
                                                 {"calibrationFile", path},
                                                 {"roiFile", roi_path->text().trimmed()},
                                                 {"returnCode", json.value("calibrationCode").toInt(json_code(json))},
                                             });
                   refresh_calibration_status();
                 });
  });

  QObject::connect(roi_apply, &QPushButton::clicked, [&]() {
    const QString ip = selected_or_log();
    const QString path = roi_path->text().trimmed();
    if (ip.isEmpty() || path.isEmpty()) {
      log_line(log, zh(u8"请选择相机和 ROI 文件。"));
      return;
    }
    request_json(network, "POST", origin + "/api/roi/load", QJsonObject{{"ip", ip}, {"path", path}}, log,
                 [&, ip, path](const QJsonObject& json) {
                   calibration_log->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"应用 ROI %1，返回码 %2")).arg(ip).arg(json_code(json)));
                   append_calibration_record(log,
                                             QJsonObject{
                                                 {"time", QDateTime::currentDateTime().toString(Qt::ISODateWithMs)},
                                                 {"action", "roi-load"},
                                                 {"ip", ip},
                                                 {"calibrationFile", calibration_path->text().trimmed()},
                                                 {"roiFile", path},
                                                 {"returnCode", json.value("roiCode").toInt(json_code(json))},
                                             });
                   refresh_calibration_status();
                 });
  });

  QObject::connect(validation_capture, &QPushButton::clicked, [&]() {
    capture_validation_frame(true);
  });

  QTimer::singleShot(700, refresh_all);
  QObject::connect(poll_timer, &QTimer::timeout, refresh_all);
  poll_timer->start(3000);

  log_line(log, zh(u8"Qt 采集端已启动，所有相机默认使用软触发。"));
  window.show();
  return app.exec();
}

