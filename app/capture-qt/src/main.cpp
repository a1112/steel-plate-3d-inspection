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
#include <QFrame>
#include <QGridLayout>
#include <QGroupBox>
#include <QGuiApplication>
#include <QHeaderView>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QList>
#include <QMainWindow>
#include <QMessageBox>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPainter>
#include <QPlainTextEdit>
#include <QPixmap>
#include <QProcess>
#include <QPushButton>
#include <QScrollArea>
#include <QScreen>
#include <QSignalBlocker>
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
#include <QVector>
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

struct CrossSectionPoint {
  QString ip;
  QString sn;
  double x = 0.0;
  double z = 0.0;
  double corrected_x = 0.0;
  double corrected_z = 0.0;
};

class CrossSectionPlotWidget final : public QWidget {
 public:
  explicit CrossSectionPlotWidget(QWidget* parent = nullptr) : QWidget(parent) {
    setMinimumHeight(320);
    setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Expanding);
    setMouseTracking(true);
  }

  void setPlotData(std::vector<CrossSectionPoint> points, QJsonObject fit, bool corrected, QString title) {
    points_ = std::move(points);
    fit_ = std::move(fit);
    corrected_ = corrected;
    title_ = std::move(title);
    update();
  }

 protected:
  void paintEvent(QPaintEvent*) override {
    QPainter painter(this);
    painter.setRenderHint(QPainter::Antialiasing, true);
    painter.fillRect(rect(), QColor("#071013"));
    painter.setPen(QColor("#29424b"));
    painter.drawRect(rect().adjusted(0, 0, -1, -1));

    if (points_.empty() || fit_.isEmpty()) {
      painter.setPen(QColor("#9fb8bf"));
      painter.drawText(rect(), Qt::AlignCenter, title_.isEmpty() ? QStringLiteral("No cross-section points") : title_);
      return;
    }

    const double cx = fit_.value("centerX").toDouble();
    const double cz = fit_.value("centerZ").toDouble();
    const double radius = fit_.value("radius").toDouble();
    double min_x = cx - radius;
    double max_x = cx + radius;
    double min_z = cz - radius;
    double max_z = cz + radius;
    for (const auto& point : points_) {
      const double x = corrected_ ? point.corrected_x : point.x;
      const double z = corrected_ ? point.corrected_z : point.z;
      min_x = std::min(min_x, x);
      max_x = std::max(max_x, x);
      min_z = std::min(min_z, z);
      max_z = std::max(max_z, z);
    }
    const double span = std::max({max_x - min_x, max_z - min_z, 1.0});
    const double center_x = (min_x + max_x) * 0.5;
    const double center_z = (min_z + max_z) * 0.5;
    min_x = center_x - span * 0.56;
    max_x = center_x + span * 0.56;
    min_z = center_z - span * 0.56;
    max_z = center_z + span * 0.56;

    const int left = 54;
    const int top = 44;
    const int right = width() - 24;
    const int bottom = height() - 44;
    const double sx = (right - left) / std::max(1e-9, max_x - min_x);
    const double sz = (bottom - top) / std::max(1e-9, max_z - min_z);
    const double scale = std::min(sx, sz);
    auto to_px = [&](double x, double z) {
      const double px = left + (x - min_x) * scale;
      const double py = bottom - (z - min_z) * scale;
      return QPointF(px, py);
    };

    painter.setPen(QPen(QColor("#162a31"), 1));
    for (double gx = std::floor(min_x / 10.0) * 10.0; gx <= max_x; gx += 10.0) {
      const QPointF a = to_px(gx, min_z);
      const QPointF b = to_px(gx, max_z);
      painter.drawLine(QPointF(a.x(), top), QPointF(b.x(), bottom));
    }
    for (double gz = std::floor(min_z / 10.0) * 10.0; gz <= max_z; gz += 10.0) {
      const QPointF a = to_px(min_x, gz);
      const QPointF b = to_px(max_x, gz);
      painter.drawLine(QPointF(left, a.y()), QPointF(right, b.y()));
    }

    const QPointF center = to_px(cx, cz);
    painter.setPen(QPen(QColor("#d7e8eb"), 2));
    painter.drawEllipse(center, radius * scale, radius * scale);
    painter.setBrush(QColor("#f6f9fb"));
    painter.drawEllipse(center, 3, 3);
    painter.setBrush(Qt::NoBrush);

    const QVector<QColor> palette{
        QColor("#e63946"), QColor("#1d75d1"), QColor("#1e9b50"),
        QColor("#f7951e"), QColor("#8246c8"), QColor("#00a0aa"),
    };
    std::map<QString, int> camera_index;
    for (const auto& point : points_) {
      if (camera_index.find(point.ip) == camera_index.end()) {
        camera_index[point.ip] = static_cast<int>(camera_index.size());
      }
      const QColor color = palette.at(camera_index[point.ip] % palette.size());
      painter.setPen(QPen(color, 2));
      const QPointF px = to_px(corrected_ ? point.corrected_x : point.x, corrected_ ? point.corrected_z : point.z);
      painter.drawPoint(px);
    }

    painter.setPen(QColor("#e5f7fa"));
    painter.drawText(QRect(14, 8, width() - 28, 22), Qt::AlignLeft | Qt::AlignVCenter, title_);
    painter.setPen(QColor("#9fb8bf"));
    const QString metrics = QString("diameter %1 mm | mean residual %2 mm | points %3")
                                .arg(fit_.value("diameter").toDouble(), 0, 'f', 3)
                                .arg(fit_.value("meanAbsResidual").toDouble(), 0, 'f', 4)
                                .arg(points_.size());
    painter.drawText(QRect(14, height() - 32, width() - 28, 22), Qt::AlignLeft | Qt::AlignVCenter, metrics);

    int legend_x = 14;
    int legend_y = 36;
    painter.setFont(QFont(painter.font().family(), 8));
    for (const auto& item : camera_index) {
      const QColor color = palette.at(item.second % palette.size());
      painter.fillRect(QRect(legend_x, legend_y + 4, 12, 12), color);
      painter.setPen(QColor("#c7dde2"));
      painter.drawText(QRect(legend_x + 18, legend_y, 180, 20), Qt::AlignLeft | Qt::AlignVCenter, item.first);
      legend_y += 18;
      if (legend_y > height() - 80) {
        legend_y = 36;
        legend_x += 210;
      }
    }
  }

 private:
  std::vector<CrossSectionPoint> points_;
  QJsonObject fit_;
  bool corrected_ = false;
  QString title_;
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

QLabel* status_dot(const QColor& color = QColor("#4b626b")) {
  auto* label = new QLabel();
  label->setFixedSize(12, 12);
  label->setStyleSheet(QString("background: %1; border-radius: 6px;").arg(color.name()));
  return label;
}

void set_status_dot(QLabel* dot, const QColor& color) {
  if (dot) {
    dot->setStyleSheet(QString("background: %1; border-radius: 6px;").arg(color.name()));
  }
}

QWidget* indicator_item(QLabel* dot, const QString& text) {
  auto* widget = new QWidget();
  auto* layout = new QHBoxLayout(widget);
  layout->setContentsMargins(0, 0, 0, 0);
  layout->setSpacing(6);
  layout->addWidget(dot, 0, Qt::AlignVCenter);
  auto* label = small_label(text);
  label->setObjectName("muted");
  layout->addWidget(label, 1);
  return widget;
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

  const QRect available_geometry = QGuiApplication::primaryScreen()
                                       ? QGuiApplication::primaryScreen()->availableGeometry()
                                       : QRect(0, 0, 1920, 1080);
  const bool compact_1080 = available_geometry.height() <= 1080;
  const int window_width = std::max(1280, std::min(available_geometry.width() - 80, compact_1080 ? 1680 : 1780));
  const int window_height = std::max(760, std::min(available_geometry.height() - 80, compact_1080 ? 920 : 980));
  const int panel_spacing = compact_1080 ? 6 : 10;
  const int root_margin = compact_1080 ? 8 : 12;
  const int overview_card_height = compact_1080 ? 154 : 190;
  const int overview_log_height = compact_1080 ? 84 : 120;
  const QSize preview_minimum = compact_1080 ? QSize(520, 360) : QSize(620, 520);

  QMainWindow window;
  window.setWindowTitle(zh(u8"钢板 3D 采集工作台"));
  window.resize(window_width, window_height);
  window.setMinimumSize(compact_1080 ? QSize(1280, 760) : QSize(1360, 820));
  window.move(available_geometry.center() - window.rect().center());

  auto* central = new QWidget(&window);
  auto* root = new QVBoxLayout(central);
  root->setContentsMargins(root_margin, root_margin, root_margin, root_margin);
  root->setSpacing(panel_spacing);

  auto* top_bar = new QHBoxLayout();
  auto* title = new QLabel(zh(u8"钢板 3D 采集工作台"));
  title->setObjectName("title");
  auto* api_state = small_label(zh(u8"内置采集 API 启动中：") + origin);
  auto* provider_hint = small_label(zh(u8"Rust provider：qt-terminal"));
  provider_hint->setObjectName("muted");
  auto* overview_page_button = new QPushButton(zh(u8"总览"));
  auto* preview_page_button = new QPushButton(zh(u8"相机预览"));
  auto* config_page_button = new QPushButton(zh(u8"配置管理"));
  auto* calibration_page_button = new QPushButton(zh(u8"自动标定"));
  auto* test_button = new QPushButton(zh(u8"测试"));
  overview_page_button->setObjectName("modeButton");
  preview_page_button->setObjectName("modeButton");
  config_page_button->setObjectName("modeButton");
  calibration_page_button->setObjectName("modeButton");
  auto* open_api = new QPushButton(zh(u8"打开 API 控制台"));
  top_bar->addWidget(title, 0);
  top_bar->addSpacing(12);
  top_bar->addWidget(api_state, 1);
  top_bar->addWidget(overview_page_button, 0);
  top_bar->addWidget(preview_page_button, 0);
  top_bar->addWidget(config_page_button, 0);
  top_bar->addWidget(calibration_page_button, 0);
  top_bar->addWidget(test_button, 0);
  top_bar->addWidget(provider_hint, 0);
  top_bar->addWidget(open_api, 0);
  root->addLayout(top_bar);

  auto* main_stack = new QStackedWidget();
  root->addWidget(main_stack, 1);

  auto* overview_page = new QWidget();
  auto* overview_layout = new QVBoxLayout(overview_page);
  overview_layout->setContentsMargins(0, 0, 0, 0);
  overview_layout->setSpacing(panel_spacing);
  auto* overview_status_group = new QGroupBox(zh(u8"整体状态"));
  auto* overview_status_layout = new QGridLayout(overview_status_group);
  auto* overview_api = value_label(origin);
  auto* overview_sdk = value_label(zh(u8"等待刷新"));
  auto* overview_storage = value_label("-");
  auto* overview_profile = value_label("-");
  auto* overview_counts = value_label("-");
  auto* overview_last_capture = value_label(zh(u8"尚未采集"));
  auto* overview_trigger = value_label("-");
  auto* overview_fps = value_label("-");
  auto* overview_system = value_label(zh(u8"待机"));
  auto* overview_steel = value_label(zh(u8"待进钢"));
  auto* overview_session = value_label("-");
  overview_status_layout->addWidget(new QLabel(zh(u8"API")), 0, 0);
  overview_status_layout->addWidget(overview_api, 0, 1);
  overview_status_layout->addWidget(new QLabel(zh(u8"SDK / 驱动")), 0, 2);
  overview_status_layout->addWidget(overview_sdk, 0, 3);
  overview_status_layout->addWidget(new QLabel(zh(u8"存储")), 1, 0);
  overview_status_layout->addWidget(overview_storage, 1, 1);
  overview_status_layout->addWidget(new QLabel(zh(u8"当前配置")), 1, 2);
  overview_status_layout->addWidget(overview_profile, 1, 3);
  overview_status_layout->addWidget(new QLabel(zh(u8"相机统计")), 2, 0);
  overview_status_layout->addWidget(overview_counts, 2, 1);
  overview_status_layout->addWidget(new QLabel(zh(u8"最近采集")), 2, 2);
  overview_status_layout->addWidget(overview_last_capture, 2, 3);
  overview_status_layout->addWidget(new QLabel(zh(u8"整体触发")), 3, 0);
  overview_status_layout->addWidget(overview_trigger, 3, 1);
  overview_status_layout->addWidget(new QLabel(zh(u8"FPS / 预览")), 3, 2);
  overview_status_layout->addWidget(overview_fps, 3, 3);
  overview_status_layout->addWidget(new QLabel(zh(u8"采集系统")), 4, 0);
  overview_status_layout->addWidget(overview_system, 4, 1);
  overview_status_layout->addWidget(new QLabel(zh(u8"进出钢")), 4, 2);
  overview_status_layout->addWidget(overview_steel, 4, 3);
  overview_status_layout->addWidget(new QLabel(zh(u8"生产会话")), 5, 0);
  overview_status_layout->addWidget(overview_session, 5, 1, 1, 3);
  overview_status_layout->setColumnStretch(1, 1);
  overview_status_layout->setColumnStretch(3, 1);

  auto* overview_controls = new QHBoxLayout();
  auto* overview_refresh = new QPushButton(zh(u8"刷新全部"));
  auto* overview_connect_all = new QPushButton(zh(u8"自动连接 6 台"));
  auto* overview_load_params = new QPushButton(zh(u8"加载当前配置参数"));
  auto* overview_stop_streams = new QPushButton(zh(u8"停止全部预览"));
  auto* overview_steel_in = new QPushButton(zh(u8"进钢"));
  auto* overview_steel_out = new QPushButton(zh(u8"出钢"));
  auto* overview_open_storage = new QPushButton(zh(u8"打开存储目录"));
  auto* overview_open_steel_dir = new QPushButton(zh(u8"打开钢板目录"));
  auto* overview_open_summary = new QPushButton(zh(u8"打开最新 summary"));
  overview_controls->addWidget(overview_refresh);
  overview_controls->addWidget(overview_connect_all);
  overview_controls->addWidget(overview_load_params);
  overview_controls->addWidget(overview_stop_streams);
  overview_controls->addWidget(overview_steel_in);
  overview_controls->addWidget(overview_steel_out);
  overview_controls->addWidget(overview_open_storage);
  overview_controls->addWidget(overview_open_steel_dir);
  overview_controls->addWidget(overview_open_summary);
  overview_controls->addStretch(1);

  auto* overview_scroll = new QScrollArea();
  overview_scroll->setWidgetResizable(true);
  overview_scroll->setFrameShape(QFrame::NoFrame);
  auto* overview_card_host = new QWidget();
  auto* overview_cards_grid = new QGridLayout(overview_card_host);
  overview_cards_grid->setContentsMargins(0, 0, 0, 0);
  overview_cards_grid->setSpacing(10);
  struct OverviewCard {
    QFrame* frame = nullptr;
    QLabel* title = nullptr;
    QLabel* subtitle = nullptr;
    QLabel* state = nullptr;
    QLabel* config = nullptr;
    QLabel* capture = nullptr;
    QLabel* output = nullptr;
    QPushButton* jump = nullptr;
    QString ip;
  };
  std::vector<OverviewCard> overview_cards;
  overview_cards.reserve(6);
  for (int i = 0; i < 6; ++i) {
    OverviewCard card;
    card.frame = new QFrame();
    card.frame->setObjectName("overviewCard");
    card.frame->setMinimumHeight(overview_card_height);
    card.frame->setProperty("ip", "");
    auto* card_layout = new QVBoxLayout(card.frame);
    card_layout->setSpacing(6);
    auto* card_top = new QHBoxLayout();
    card.title = new QLabel(QString(zh(u8"相机槽位 %1")).arg(i + 1));
    card.title->setObjectName("sectionTitle");
    card.jump = new QPushButton(zh(u8"预览"));
    card.jump->setEnabled(false);
    card_top->addWidget(card.title, 1);
    card_top->addWidget(card.jump, 0);
    card.subtitle = small_label(zh(u8"等待发现"));
    card.state = value_label("-");
    card.config = value_label("-");
    card.capture = value_label("-");
    card.output = value_label("-");
    card_layout->addLayout(card_top);
    card_layout->addWidget(card.subtitle);
    card_layout->addWidget(card.state);
    card_layout->addWidget(card.config);
    card_layout->addWidget(card.capture);
    card_layout->addWidget(card.output, 1);
    overview_cards_grid->addWidget(card.frame, i / 3, i % 3);
    overview_cards.push_back(card);
  }
  overview_cards_grid->setColumnStretch(0, 1);
  overview_cards_grid->setColumnStretch(1, 1);
  overview_cards_grid->setColumnStretch(2, 1);
  overview_scroll->setWidget(overview_card_host);

  auto* overview_log = new QPlainTextEdit();
  overview_log->setReadOnly(true);
  overview_log->setMaximumBlockCount(400);
  overview_log->setMaximumHeight(overview_log_height);
  overview_layout->addWidget(overview_status_group);
  overview_layout->addLayout(overview_controls);
  overview_layout->addWidget(overview_scroll, 1);
  overview_layout->addWidget(overview_log, 0);
  main_stack->addWidget(overview_page);

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
  config_page_layout->setSpacing(panel_spacing);
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
  profile_manage_table->setMaximumHeight(compact_1080 ? 132 : 220);
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
  config_manager_group->setMaximumHeight(compact_1080 ? 230 : 320);
  config_page_layout->addWidget(config_manager_group, 0);
  main_stack->addWidget(config_page);

  auto* left_panel = new QWidget();
  auto* left_layout = new QVBoxLayout(left_panel);
  left_layout->setContentsMargins(0, 0, 0, 0);
  left_layout->setSpacing(panel_spacing);
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
  center_layout->setContentsMargins(compact_1080 ? 6 : 8, 0, compact_1080 ? 6 : 8, 0);
  center_layout->setSpacing(panel_spacing);
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
  preview->setMinimumSize(preview_minimum);
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
  storage_status_text->setMinimumHeight(compact_1080 ? 120 : 180);
  storage_layout->addWidget(storage_group);
  storage_layout->addWidget(storage_status_text, 1);
  config_tabs->addTab(storage_tab, zh(u8"存储配置"));

  auto* camera_config_tab = new QWidget();
  auto* camera_config_layout = new QVBoxLayout(camera_config_tab);
  camera_config_layout->setContentsMargins(0, 0, 0, 0);
  camera_config_layout->setSpacing(0);
  auto* camera_config_splitter = new QSplitter(Qt::Horizontal);
  auto* camera_config_left = new QWidget();
  auto* camera_config_left_layout = new QVBoxLayout(camera_config_left);
  camera_config_left_layout->setContentsMargins(0, 0, compact_1080 ? 6 : 8, 0);
  camera_config_left_layout->setSpacing(panel_spacing);
  auto* camera_config_left_title = new QLabel(zh(u8"相机"));
  camera_config_left_title->setObjectName("sectionTitle");
  auto* profile_camera_table = new QTableWidget(0, 10);
  profile_camera_table->setHorizontalHeaderLabels({
      zh(u8"相机"),
      zh(u8"IP 地址"),
      zh(u8"启用"),
      zh(u8"型号"),
      zh(u8"序列号"),
      zh(u8"参数来源"),
      zh(u8"参数文件"),
      zh(u8"曝光"),
      zh(u8"增益"),
      zh(u8"触发频率"),
  });
  profile_camera_table->horizontalHeader()->setStretchLastSection(true);
  profile_camera_table->horizontalHeader()->setSectionResizeMode(0, QHeaderView::Stretch);
  for (int column = 1; column < profile_camera_table->columnCount(); ++column) {
    profile_camera_table->setColumnHidden(column, true);
  }
  profile_camera_table->verticalHeader()->setVisible(false);
  profile_camera_table->setSelectionBehavior(QAbstractItemView::SelectRows);
  profile_camera_table->setSelectionMode(QAbstractItemView::SingleSelection);
  profile_camera_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  auto* camera_list_hint = small_label(zh(u8"左侧只用于选择相机；参数在右侧编辑。"));
  camera_list_hint->setObjectName("muted");
  camera_config_left_layout->addWidget(camera_config_left_title);
  camera_config_left_layout->addWidget(profile_camera_table, 1);
  camera_config_left_layout->addWidget(camera_list_hint);

  auto* camera_config_right = new QWidget();
  auto* camera_config_right_layout = new QVBoxLayout(camera_config_right);
  camera_config_right_layout->setContentsMargins(compact_1080 ? 6 : 8, 0, 0, 0);
  camera_config_right_layout->setSpacing(panel_spacing);
  auto* camera_edit_group = new QGroupBox(zh(u8"单台相机配置编辑"));
  auto* camera_edit_form = new QFormLayout(camera_edit_group);
  camera_edit_form->setFieldGrowthPolicy(QFormLayout::AllNonFixedFieldsGrow);
  auto* edit_camera_ip = new QLineEdit();
  auto* edit_camera_enabled = new QCheckBox(zh(u8"启用此相机"));
  edit_camera_enabled->setChecked(true);
  auto* edit_camera_model = new QLineEdit();
  auto* edit_camera_sn = new QLineEdit();
  auto* edit_camera_param_source = new QComboBox();
  edit_camera_param_source->addItem(zh(u8"使用相机内置参数"), "device");
  edit_camera_param_source->addItem(zh(u8"使用配置文件 .nccfg"), "file");
  auto* edit_camera_param_file = new QLineEdit();
  auto* edit_camera_param_browse = new QPushButton(zh(u8"选择"));
  auto* edit_camera_load_file = new QPushButton(zh(u8"直接加载"));
  auto* edit_camera_use_device = new QPushButton(zh(u8"使用当前读回"));
  edit_camera_load_file->setToolTip(zh(u8"立即把此配置文件加载到当前相机，不保存到设备，除非勾选全局写设备。"));
  edit_camera_use_device->setToolTip(zh(u8"使用相机当前内置/已生效参数，不从配置文件覆盖。"));
  auto* edit_camera_param_row = new QHBoxLayout();
  edit_camera_param_row->addWidget(edit_camera_param_file, 1);
  edit_camera_param_row->addWidget(edit_camera_param_browse);
  edit_camera_param_row->addWidget(edit_camera_load_file);
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
  camera_config_buttons->addWidget(edit_camera_use_device);
  camera_config_buttons->addStretch(1);
  camera_edit_form->addRow(zh(u8"IP 地址"), edit_camera_ip);
  camera_edit_form->addRow(edit_camera_enabled);
  camera_edit_form->addRow(zh(u8"型号"), edit_camera_model);
  camera_edit_form->addRow(zh(u8"序列号"), edit_camera_sn);
  camera_edit_form->addRow(zh(u8"参数来源"), edit_camera_param_source);
  camera_edit_form->addRow(zh(u8"参数文件"), edit_camera_param_row);
  camera_edit_form->addRow(zh(u8"曝光"), edit_camera_exposure);
  camera_edit_form->addRow(zh(u8"增益"), edit_camera_gain);
  camera_edit_form->addRow(zh(u8"触发频率"), edit_camera_trigger_freq);
  camera_edit_form->addRow(camera_config_buttons);
  auto* camera_source_hint = value_label(zh(u8"内置参数：应用配置时保留相机当前生效配置；配置文件：可立即加载 .nccfg。"));
  camera_config_right_layout->addWidget(camera_edit_group, 0);
  camera_config_right_layout->addWidget(camera_source_hint, 0);
  camera_config_right_layout->addStretch(1);
  camera_config_splitter->addWidget(camera_config_left);
  camera_config_splitter->addWidget(camera_config_right);
  camera_config_splitter->setStretchFactor(0, 0);
  camera_config_splitter->setStretchFactor(1, 1);
  camera_config_splitter->setSizes(compact_1080 ? QList<int>{270, 720} : QList<int>{320, 760});
  camera_config_layout->addWidget(camera_config_splitter, 1);
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
  data_mode->addItem(zh(u8"深度 + 亮度"), 3);
  data_mode->setCurrentIndex(1);
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
  param_result->setMaximumHeight(compact_1080 ? 82 : 110);
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
  calibration_layout->setContentsMargins(0, 0, 0, 0);
  calibration_layout->setSpacing(panel_spacing);
  auto* calibration_splitter = new QSplitter(Qt::Horizontal);
  auto* calibration_left_panel = new QWidget();
  auto* calibration_left_layout = new QVBoxLayout(calibration_left_panel);
  calibration_left_layout->setContentsMargins(0, 0, compact_1080 ? 6 : 8, 0);
  calibration_left_layout->setSpacing(panel_spacing);
  auto* calibration_versions_group = new QGroupBox(zh(u8"标定版本"));
  auto* calibration_versions_layout = new QVBoxLayout(calibration_versions_group);
  auto* calibration_versions_table = new QTableWidget(0, 4);
  calibration_versions_table->setHorizontalHeaderLabels({
      zh(u8"版本"),
      zh(u8"状态"),
      zh(u8"残差"),
      zh(u8"目录"),
  });
  calibration_versions_table->horizontalHeader()->setStretchLastSection(true);
  calibration_versions_table->horizontalHeader()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
  calibration_versions_table->horizontalHeader()->setSectionResizeMode(1, QHeaderView::ResizeToContents);
  calibration_versions_table->horizontalHeader()->setSectionResizeMode(2, QHeaderView::ResizeToContents);
  calibration_versions_table->verticalHeader()->setVisible(false);
  calibration_versions_table->setSelectionBehavior(QAbstractItemView::SelectRows);
  calibration_versions_table->setSelectionMode(QAbstractItemView::SingleSelection);
  calibration_versions_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  calibration_versions_table->setMaximumHeight(compact_1080 ? 150 : 220);
  calibration_versions_layout->addWidget(calibration_versions_table);
  auto* calibration_fit_report_path = new QLineEdit();
  calibration_fit_report_path->setPlaceholderText(zh(u8"fit_report.json"));
  auto* calibration_import_fit = new QPushButton(zh(u8"导入 fit_report"));
  auto* calibration_fit_row = new QHBoxLayout();
  calibration_fit_row->addWidget(calibration_fit_report_path, 1);
  calibration_fit_row->addWidget(calibration_import_fit);
  calibration_versions_layout->addLayout(calibration_fit_row);

  auto* calibration_actions_group = new QGroupBox(zh(u8"自动标定操作"));
  auto* calibration_actions_layout = new QGridLayout(calibration_actions_group);
  auto* calibration_auto_fit = new QPushButton(zh(u8"自动标定"));
  auto* calibration_set_current = new QPushButton(zh(u8"设为当前"));
  auto* calibration_apply_all = new QPushButton(zh(u8"覆盖应用到 6 台"));
  auto* calibration_save_params = new QPushButton(zh(u8"保存相机参数"));
  auto* calibration_open_version = new QPushButton(zh(u8"打开版本目录"));
  auto* calibration_refresh_active = new QPushButton(zh(u8"刷新当前"));
  calibration_apply_all->setObjectName("dangerButton");
  calibration_auto_fit->setToolTip(zh(u8"执行 6 相机一轮并行采集并自动拟合，完成后在右侧同时显示原始与修正结果。"));
  calibration_apply_all->setToolTip(zh(u8"切换当前阵列标定文件，逐台尝试 SDK 标定加载，并保存相机参数到设备。"));
  calibration_actions_layout->addWidget(calibration_auto_fit, 0, 0);
  calibration_actions_layout->addWidget(calibration_refresh_active, 0, 1);
  calibration_actions_layout->addWidget(calibration_set_current, 1, 0);
  calibration_actions_layout->addWidget(calibration_apply_all, 1, 1);
  calibration_actions_layout->addWidget(calibration_save_params, 2, 0);
  calibration_actions_layout->addWidget(calibration_open_version, 2, 1);

  auto* calibration_group = new QGroupBox(zh(u8"单相机 / ROI / 验证"));
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
  calibration_log->setMaximumBlockCount(1200);
  calibration_left_layout->addWidget(calibration_versions_group);
  calibration_left_layout->addWidget(calibration_actions_group);
  calibration_left_layout->addWidget(calibration_group);
  calibration_left_layout->addWidget(calibration_log, 1);

  auto* calibration_detail_panel = new QWidget();
  auto* calibration_detail_layout = new QVBoxLayout(calibration_detail_panel);
  calibration_detail_layout->setContentsMargins(compact_1080 ? 6 : 8, 0, 0, 0);
  calibration_detail_layout->setSpacing(panel_spacing);
  auto* calibration_metrics_row = new QSplitter(Qt::Horizontal);
  auto* calibration_original_form_group = new QGroupBox(zh(u8"原始标定参数"));
  auto* calibration_original_form = new QFormLayout(calibration_original_form_group);
  auto* calibration_original_xml = value_label();
  auto* calibration_original_diameter = value_label();
  auto* calibration_original_residual = value_label();
  auto* calibration_original_points = value_label();
  calibration_original_form->addRow(zh(u8"XML"), calibration_original_xml);
  calibration_original_form->addRow(zh(u8"直径"), calibration_original_diameter);
  calibration_original_form->addRow(zh(u8"平均残差"), calibration_original_residual);
  calibration_original_form->addRow(zh(u8"点数"), calibration_original_points);

  auto* calibration_corrected_form_group = new QGroupBox(zh(u8"修正标定参数"));
  auto* calibration_corrected_form = new QFormLayout(calibration_corrected_form_group);
  auto* calibration_corrected_xml = value_label();
  auto* calibration_corrected_diameter = value_label();
  auto* calibration_corrected_residual = value_label();
  auto* calibration_corrected_points = value_label();
  auto* calibration_corrected_version = value_label();
  calibration_corrected_form->addRow(zh(u8"版本"), calibration_corrected_version);
  calibration_corrected_form->addRow(zh(u8"XML"), calibration_corrected_xml);
  calibration_corrected_form->addRow(zh(u8"直径"), calibration_corrected_diameter);
  calibration_corrected_form->addRow(zh(u8"平均残差"), calibration_corrected_residual);
  calibration_corrected_form->addRow(zh(u8"点数"), calibration_corrected_points);
  calibration_metrics_row->addWidget(calibration_original_form_group);
  calibration_metrics_row->addWidget(calibration_corrected_form_group);
  calibration_metrics_row->setStretchFactor(0, 1);
  calibration_metrics_row->setStretchFactor(1, 1);

  auto* calibration_plot_row = new QSplitter(Qt::Horizontal);
  auto* calibration_original_plot = new CrossSectionPlotWidget();
  calibration_original_plot->setMinimumHeight(compact_1080 ? 300 : 440);
  auto* calibration_corrected_plot = new CrossSectionPlotWidget();
  calibration_corrected_plot->setMinimumHeight(compact_1080 ? 300 : 440);
  calibration_plot_row->addWidget(calibration_original_plot);
  calibration_plot_row->addWidget(calibration_corrected_plot);
  calibration_plot_row->setStretchFactor(0, 1);
  calibration_plot_row->setStretchFactor(1, 1);

  auto* calibration_compare_table = new QTableWidget(0, 9);
  calibration_compare_table->setHorizontalHeaderLabels({
      zh(u8"相机"),
      "SN",
      "dx",
      "dz",
      zh(u8"位移"),
      zh(u8"原始残差"),
      zh(u8"修正残差"),
      zh(u8"改善"),
      zh(u8"深度图"),
  });
  calibration_compare_table->horizontalHeader()->setStretchLastSection(true);
  calibration_compare_table->verticalHeader()->setVisible(false);
  calibration_compare_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  calibration_detail_layout->addWidget(calibration_metrics_row, 0);
  calibration_detail_layout->addWidget(calibration_plot_row, 2);
  calibration_detail_layout->addWidget(calibration_compare_table, 1);

  calibration_splitter->addWidget(calibration_left_panel);
  calibration_splitter->addWidget(calibration_detail_panel);
  calibration_splitter->setStretchFactor(0, 0);
  calibration_splitter->setStretchFactor(1, 1);
  calibration_splitter->setSizes(compact_1080 ? QList<int>{500, 980} : QList<int>{560, 1000});
  calibration_layout->addWidget(calibration_splitter, 1);

  auto* profile_tab = new QWidget();
  auto* profile_layout = new QVBoxLayout(profile_tab);
  profile_layout->setContentsMargins(0, 0, 0, 0);
  profile_layout->setSpacing(0);
  auto* profile_group = new QGroupBox(zh(u8"全局采集配置"));
  auto* profile_form = new QFormLayout(profile_group);
  profile_form->setFieldGrowthPolicy(QFormLayout::AllNonFixedFieldsGrow);
  auto* profile_name = new QLineEdit("default");
  auto* profile_driver_mode = new QComboBox();
  profile_driver_mode->addItem(zh(u8"真实 SDK"), "lvm");
  profile_driver_mode->addItem(zh(u8"离线模拟"), "simulated");
  auto* profile_startup_mode = new QComboBox();
  profile_startup_mode->addItem(zh(u8"手动启动"), "manual");
  profile_startup_mode->addItem(zh(u8"启动后自动连接"), "auto-connect");
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
  auto* profile_refresh = new QPushButton(zh(u8"刷新"));
  auto* profile_generate = new QPushButton(zh(u8"生成"));
  auto* profile_save = new QPushButton(zh(u8"保存"));
  auto* profile_apply = new QPushButton(zh(u8"应用"));
  profile_refresh->setToolTip(zh(u8"刷新配置状态"));
  profile_generate->setToolTip(zh(u8"根据当前界面生成配置 JSON"));
  profile_save->setToolTip(zh(u8"保存配置文件"));
  profile_apply->setToolTip(zh(u8"应用/切换配置"));
  profile_buttons->addWidget(profile_refresh);
  profile_buttons->addWidget(profile_generate);
  profile_buttons->addWidget(profile_save);
  profile_buttons->addWidget(profile_apply);
  auto* profile_param_buttons = new QHBoxLayout();
  auto* profile_save_camera_params = new QPushButton(zh(u8"保存参数"));
  auto* profile_load_camera_params_button = new QPushButton(zh(u8"加载参数"));
  profile_save_camera_params->setToolTip(zh(u8"保存全部相机参数文件"));
  profile_load_camera_params_button->setToolTip(zh(u8"加载全部相机参数文件"));
  profile_param_buttons->addWidget(profile_save_camera_params);
  profile_param_buttons->addWidget(profile_load_camera_params_button);
  auto* profile_json = new QPlainTextEdit();
  profile_json->setMinimumHeight(compact_1080 ? 300 : 520);
  auto* profile_result = new QPlainTextEdit();
  profile_result->setReadOnly(true);
  profile_result->setMinimumHeight(compact_1080 ? 96 : 160);
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

  auto* profile_state_group = new QGroupBox(zh(u8"配置状态"));
  auto* profile_state_layout = new QGridLayout(profile_state_group);
  auto* profile_driver_dot = status_dot();
  auto* profile_auto_dot = status_dot();
  auto* profile_param_dot = status_dot();
  auto* profile_device_dot = status_dot();
  auto* profile_storage_dot = status_dot();
  auto* profile_state_hint = value_label(zh(u8"颜色灯显示当前配置风险"));
  profile_state_layout->addWidget(indicator_item(profile_driver_dot, zh(u8"真实 SDK")), 0, 0);
  profile_state_layout->addWidget(indicator_item(profile_auto_dot, zh(u8"自动连接")), 0, 1);
  profile_state_layout->addWidget(indicator_item(profile_param_dot, zh(u8"参数文件")), 1, 0);
  profile_state_layout->addWidget(indicator_item(profile_device_dot, zh(u8"写入设备")), 1, 1);
  profile_state_layout->addWidget(indicator_item(profile_storage_dot, zh(u8"切换存储")), 2, 0);
  profile_state_layout->addWidget(profile_state_hint, 2, 1);

  auto* profile_left_panel = new QWidget();
  auto* profile_left_layout = new QVBoxLayout(profile_left_panel);
  profile_left_layout->setContentsMargins(0, 0, compact_1080 ? 6 : 8, 0);
  profile_left_layout->setSpacing(panel_spacing);
  profile_left_layout->addWidget(profile_group, 0);
  profile_left_layout->addWidget(profile_state_group, 0);
  profile_left_layout->addStretch(1);
  auto* profile_left_scroll = new QScrollArea();
  profile_left_scroll->setWidgetResizable(true);
  profile_left_scroll->setFrameShape(QFrame::NoFrame);
  profile_left_scroll->setWidget(profile_left_panel);

  auto* profile_json_panel = new QWidget();
  auto* profile_json_layout = new QVBoxLayout(profile_json_panel);
  profile_json_layout->setContentsMargins(compact_1080 ? 6 : 8, 0, 0, 0);
  profile_json_layout->setSpacing(panel_spacing);
  auto* profile_json_title = new QLabel(zh(u8"配置 JSON"));
  profile_json_title->setObjectName("sectionTitle");
  auto* profile_result_title = new QLabel(zh(u8"API 返回"));
  profile_result_title->setObjectName("sectionTitle");
  profile_json_layout->addWidget(profile_json_title);
  profile_json_layout->addWidget(profile_json, 3);
  profile_json_layout->addWidget(profile_result_title);
  profile_json_layout->addWidget(profile_result, 1);

  auto* profile_splitter = new QSplitter(Qt::Horizontal);
  profile_splitter->addWidget(profile_left_scroll);
  profile_splitter->addWidget(profile_json_panel);
  profile_splitter->setStretchFactor(0, 0);
  profile_splitter->setStretchFactor(1, 1);
  profile_splitter->setSizes(compact_1080 ? QList<int>{440, 960} : QList<int>{520, 920});
  profile_layout->addWidget(profile_splitter, 1);
  config_tabs->addTab(profile_tab, zh(u8"全局配置"));
  main_stack->addWidget(calibration_tab);

  auto* test_dialog = new QDialog(&window);
  test_dialog->setWindowTitle(zh(u8"采集测试与业务事件"));
  test_dialog->resize(std::min(1180, available_geometry.width() - 140),
                      std::min(compact_1080 ? 820 : 860, available_geometry.height() - 140));
  auto* continuous_layout = new QVBoxLayout(test_dialog);
  continuous_layout->setContentsMargins(root_margin, root_margin, root_margin, root_margin);
  continuous_layout->setSpacing(panel_spacing);
  auto* continuous_group = new QGroupBox(zh(u8"测试参数"));
  auto* continuous_form = new QFormLayout(continuous_group);
  auto* test_action = new QComboBox();
  test_action->addItem(zh(u8"一轮完整采集测试"), "one-round");
  test_action->addItem(zh(u8"稳定性连续采集测试"), "continuous");
  test_action->addItem(zh(u8"模拟进钢并写入钢板信息"), "steel-in");
  test_action->addItem(zh(u8"模拟出钢"), "steel-out");
  test_action->addItem(zh(u8"应用线扫预设（危险）"), "preset");
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
  auto* continuous_retries = new QSpinBox();
  continuous_retries->setRange(0, 10);
  continuous_retries->setValue(2);
  auto* continuous_scope = new QComboBox();
  continuous_scope->addItem(zh(u8"全部已发现相机"), "all");
  continuous_scope->addItem(zh(u8"当前选中相机"), "selected");
  auto* continuous_output_dir = new QLineEdit("continuous-test");
  auto* continuous_output_browse = new QPushButton(zh(u8"选择"));
  auto* continuous_output_row = new QHBoxLayout();
  continuous_output_row->addWidget(continuous_output_dir, 1);
  continuous_output_row->addWidget(continuous_output_browse);
  auto* test_steel_id = new QLineEdit();
  auto* test_steel_type = new QLineEdit();
  auto* test_steel_length = new QDoubleSpinBox();
  test_steel_length->setRange(0, 200000);
  test_steel_length->setDecimals(1);
  auto* test_steel_width = new QDoubleSpinBox();
  test_steel_width->setRange(0, 10000);
  test_steel_width->setDecimals(1);
  auto* test_steel_thick = new QDoubleSpinBox();
  test_steel_thick->setRange(0, 1000);
  test_steel_thick->setDecimals(2);
  continuous_form->addRow(zh(u8"动作"), test_action);
  continuous_form->addRow(zh(u8"期望相机数"), expected_camera_count);
  continuous_form->addRow(zh(u8"测试范围"), continuous_scope);
  continuous_form->addRow(zh(u8"轮数"), continuous_rounds);
  continuous_form->addRow(zh(u8"间隔"), continuous_interval_ms);
  continuous_form->addRow(zh(u8"失败重试"), continuous_retries);
  continuous_form->addRow(zh(u8"输出目录"), continuous_output_row);
  continuous_form->addRow(zh(u8"钢板号"), test_steel_id);
  continuous_form->addRow(zh(u8"钢种"), test_steel_type);
  continuous_form->addRow(zh(u8"长度"), test_steel_length);
  continuous_form->addRow(zh(u8"宽度"), test_steel_width);
  continuous_form->addRow(zh(u8"厚度"), test_steel_thick);
  auto* test_buttons = new QHBoxLayout();
  auto* test_execute = new QPushButton(zh(u8"执行"));
  auto* test_close = new QPushButton(zh(u8"关闭"));
  test_buttons->addWidget(test_execute);
  test_buttons->addWidget(test_close);
  test_buttons->addStretch(1);
  auto* continuous_summary = small_label(zh(u8"等待测试"));
  auto* continuous_table = new QTableWidget(0, 12);
  continuous_table->setHorizontalHeaderLabels({
      zh(u8"IP 地址"),
      zh(u8"连接"),
      zh(u8"尝试"),
      zh(u8"成功"),
      zh(u8"失败"),
      zh(u8"返回码"),
      zh(u8"错误名"),
      zh(u8"完整帧"),
      zh(u8"深度"),
      zh(u8"亮度"),
      zh(u8"元数据"),
      zh(u8"最新输出"),
  });
  continuous_table->horizontalHeader()->setStretchLastSection(true);
  continuous_table->horizontalHeader()->setSectionResizeMode(QHeaderView::ResizeToContents);
  continuous_table->horizontalHeader()->setSectionResizeMode(11, QHeaderView::Stretch);
  continuous_table->verticalHeader()->setVisible(false);
  continuous_table->setEditTriggers(QAbstractItemView::NoEditTriggers);
  auto* continuous_log = new QPlainTextEdit();
  continuous_log->setReadOnly(true);
  continuous_log->setMaximumBlockCount(1000);
  continuous_layout->addWidget(continuous_group);
  continuous_layout->addLayout(test_buttons);
  continuous_layout->addWidget(continuous_summary);
  continuous_layout->addWidget(continuous_table, 1);
  continuous_layout->addWidget(continuous_log, 1);

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
  splitter->setSizes(compact_1080 ? QList<int>{320, 780, 360} : QList<int>{360, 760, 420});

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
      "QPushButton#dangerButton { background: #7a2f22; border-color: #c65c43; }"
      "QPushButton#dangerButton:hover { background: #963b2b; }"
      "QFrame#overviewCard { background: #0b1114; border: 1px solid #2a3c44; border-radius: 6px; }"
      "QTabWidget::pane { border: 1px solid #2a3c44; }"
      "QTabBar::tab { background: #17242a; color: #d7e8eb; padding: 8px 12px; }"
      "QTabBar::tab:selected { background: #1d6571; color: #ffffff; }"
      "QCheckBox { spacing: 8px; }");
  if (compact_1080) {
    window.setStyleSheet(window.styleSheet() +
                         "QMainWindow, QWidget { font-size: 12px; }"
                         "QLabel#title { font-size: 20px; }"
                         "QLabel#sectionTitle { font-size: 14px; }"
                         "QLabel#valueLabel { padding: 4px 6px; }"
                         "QHeaderView::section { padding: 4px; }"
                         "QGroupBox { margin-top: 10px; padding: 7px; }"
                         "QPushButton { padding: 5px 8px; }"
                         "QTabBar::tab { padding: 6px 10px; }");
  }

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
  bool overview_one_round_running = false;
  QStringList continuous_ips;
  int continuous_round = 1;
  int continuous_index = 0;
  int continuous_total_attempts = 0;
  int continuous_total_success = 0;
  int continuous_total_failure = 0;
  QJsonObject overview_health_state;
  QJsonObject overview_storage_state;
  QJsonObject overview_config_state;
  QJsonObject overview_steel_state;
  QJsonObject overview_last_summary;
  QJsonObject calibration_fit_report;
  QJsonObject calibration_active_state;
  QString overview_last_summary_path;
  QString calibration_fit_report_file;
  QString calibration_version_dir;
  QString calibration_corrected_xml_path;
  QString calibration_before_preview_path;
  QString calibration_after_preview_path;
  QStringList overview_discovered_ips;
  std::map<QString, QJsonObject> overview_status_by_ip;
  bool profile_editor_loading = false;
  bool profile_editor_dirty = false;
  bool profile_list_refreshing = false;
  bool startup_profile_apply_attempted = false;

  struct ContinuousStats {
    int attempts = 0;
    int successes = 0;
    int failures = 0;
    int last_code = 0;
    QString error_name = "-";
    bool complete_frame = false;
    bool depth_exists = false;
    bool intensity_exists = false;
    bool metadata_exists = false;
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
    log_line(overview_log, message);
    log_line(log, message);
  };

  auto overview_log_line = [&](const QString& message) {
    log_line(overview_log, message);
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

  auto provider_local_path = [&](const QString& path) {
    const QString trimmed = path.trimmed();
    if (trimmed.isEmpty()) {
      return QString();
    }
    QFileInfo info(trimmed);
    if (info.isAbsolute()) {
      return QDir::fromNativeSeparators(info.absoluteFilePath());
    }
    QString root = overview_storage_state.value("root").toString();
    if (root.trimmed().isEmpty()) {
      root = overview_health_state.value("storageRoot").toString();
    }
    if (root.trimmed().isEmpty()) {
      root = storage_root->text().trimmed();
    }
    if (root.trimmed().isEmpty()) {
      root = "E:/steel-capture-data";
    }
    return QDir::fromNativeSeparators(QDir(root).filePath(trimmed));
  };

  auto add_version_row = [&](const QString& version, const QString& status, const QString& residual, const QString& dir) {
    int row = -1;
    for (int i = 0; i < calibration_versions_table->rowCount(); ++i) {
      if (calibration_versions_table->item(i, 0) && calibration_versions_table->item(i, 0)->text() == version) {
        row = i;
        break;
      }
    }
    if (row < 0) {
      row = calibration_versions_table->rowCount();
      calibration_versions_table->insertRow(row);
      for (int col = 0; col < calibration_versions_table->columnCount(); ++col) {
        calibration_versions_table->setItem(row, col, new QTableWidgetItem("-"));
      }
    }
    set_cell(calibration_versions_table, row, 0, version);
    set_cell(calibration_versions_table, row, 1, status);
    set_cell(calibration_versions_table, row, 2, residual);
    set_cell(calibration_versions_table, row, 3, dir);
    if (!dir.isEmpty()) {
      calibration_versions_table->item(row, 0)->setData(Qt::UserRole, dir);
    }
  };

  auto load_cross_section_points = [&](const QString& path) {
    std::vector<CrossSectionPoint> points;
    const QString local_path = provider_local_path(path);
    QFile file(local_path);
    if (!file.open(QIODevice::ReadOnly)) {
      return points;
    }
    const QList<QByteArray> lines = file.readAll().split('\n');
    for (int i = 1; i < lines.size(); ++i) {
      const QString line = QString::fromUtf8(lines.at(i)).trimmed();
      if (line.isEmpty()) {
        continue;
      }
      const QStringList cols = line.split(',');
      if (cols.size() < 7) {
        continue;
      }
      CrossSectionPoint point;
      point.ip = cols.at(0).trimmed();
      point.sn = cols.at(1).trimmed();
      point.x = cols.at(3).trimmed().toDouble();
      point.z = cols.at(4).trimmed().toDouble();
      point.corrected_x = cols.at(5).trimmed().toDouble();
      point.corrected_z = cols.at(6).trimmed().toDouble();
      points.push_back(point);
    }
    return points;
  };

  auto render_fit_report = [&](const QJsonObject& report, const QString& report_path) {
    calibration_fit_report = report;
    calibration_fit_report_file = report_path;
    calibration_fit_report_path->setText(report_path);
    calibration_version_dir = QFileInfo(report_path).absolutePath();
    calibration_corrected_xml_path = report.value("correctedXml").toString();
    calibration_before_preview_path = report.value("beforePreview").toString();
    calibration_after_preview_path = report.value("afterPreview").toString();
    const QJsonObject before = report.value("fitBefore").toObject();
    const QJsonObject after = report.value("fitAfter").toObject();
    QString points_csv_path = report.value("pointsCsv").toString();
    if (points_csv_path.trimmed().isEmpty()) {
      points_csv_path = QDir(QFileInfo(report_path).absolutePath()).filePath("cross_section_points.csv");
    }
    const std::vector<CrossSectionPoint> plot_points = load_cross_section_points(points_csv_path);
    set_value(calibration_original_xml, report.value("calibration").toString());
    set_value(calibration_original_diameter, QString("%1 mm").arg(before.value("diameter").toDouble(), 0, 'f', 3));
    set_value(calibration_original_residual, QString("%1 mm").arg(before.value("meanAbsResidual").toDouble(), 0, 'f', 4));
    set_value(calibration_original_points, QString::number(before.value("pointCount").toInt()));
    set_value(calibration_corrected_version, QFileInfo(calibration_version_dir).fileName());
    set_value(calibration_corrected_xml, calibration_corrected_xml_path);
    set_value(calibration_corrected_diameter, QString("%1 mm").arg(after.value("diameter").toDouble(), 0, 'f', 3));
    set_value(calibration_corrected_residual, QString("%1 mm").arg(after.value("meanAbsResidual").toDouble(), 0, 'f', 4));
    set_value(calibration_corrected_points, QString::number(after.value("pointCount").toInt()));
    calibration_original_plot->setPlotData(plot_points, before, false, zh(u8"原始横截面点云"));
    calibration_corrected_plot->setPlotData(plot_points, after, true, zh(u8"修正横截面点云"));
    if (plot_points.empty()) {
      log_line(calibration_log, zh(u8"未找到 cross_section_points.csv，无法在界面中绘制真实横截面点。请重新执行自动拟合。"));
    }

    calibration_compare_table->setRowCount(0);
    const QJsonArray corrections = report.value("corrections").toArray();
    for (const QJsonValue& value : corrections) {
      const QJsonObject item = value.toObject();
      const QJsonObject before_item = item.value("before").toObject();
      const QJsonObject after_item = item.value("after").toObject();
      const double before_residual = before_item.value("meanAbsResidual").toDouble();
      const double after_residual = after_item.value("meanAbsResidual").toDouble();
      const int row = calibration_compare_table->rowCount();
      calibration_compare_table->insertRow(row);
      calibration_compare_table->setItem(row, 0, new QTableWidgetItem(item.value("ip").toString()));
      calibration_compare_table->setItem(row, 1, new QTableWidgetItem(item.value("sn").toString()));
      calibration_compare_table->setItem(row, 2, new QTableWidgetItem(QString::number(item.value("dx").toDouble(), 'f', 5)));
      calibration_compare_table->setItem(row, 3, new QTableWidgetItem(QString::number(item.value("dz").toDouble(), 'f', 5)));
      calibration_compare_table->setItem(row, 4, new QTableWidgetItem(QString::number(item.value("shiftMagnitude").toDouble(), 'f', 5)));
      calibration_compare_table->setItem(row, 5, new QTableWidgetItem(QString("%1 mm").arg(before_residual, 0, 'f', 4)));
      calibration_compare_table->setItem(row, 6, new QTableWidgetItem(QString("%1 mm").arg(after_residual, 0, 'f', 4)));
      calibration_compare_table->setItem(row, 7, new QTableWidgetItem(QString("%1 mm").arg(before_residual - after_residual, 0, 'f', 4)));
      calibration_compare_table->setItem(row, 8, new QTableWidgetItem(item.value("depthPath").toString()));
    }
    const QString version = QFileInfo(calibration_version_dir).fileName();
    add_version_row(version.isEmpty() ? zh(u8"当前导入") : version,
                    zh(u8"已加载"),
                    QString("%1 -> %2 mm")
                        .arg(before.value("meanAbsResidual").toDouble(), 0, 'f', 4)
                        .arg(after.value("meanAbsResidual").toDouble(), 0, 'f', 4),
                    calibration_version_dir);
    log_line(calibration_log, QString(zh(u8"已加载拟合报告：%1")).arg(report_path));
  };

  auto load_fit_report_file = [&](const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
      log_line(calibration_log, zh(u8"读取 fit_report 失败：") + file.errorString());
      return false;
    }
    const QJsonDocument doc = QJsonDocument::fromJson(file.readAll());
    if (!doc.isObject()) {
      log_line(calibration_log, zh(u8"fit_report 不是有效 JSON。"));
      return false;
    }
    render_fit_report(doc.object(), QFileInfo(path).absoluteFilePath());
    return true;
  };

  auto profile_camera_ip_at = [&](int row) -> QString {
    auto* ip_item = profile_camera_table->item(row, 1);
    if (ip_item && !ip_item->text().trimmed().isEmpty() && ip_item->text().trimmed() != "-") {
      return ip_item->text().trimmed();
    }
    auto* display_item = profile_camera_table->item(row, 0);
    return display_item ? display_item->data(Qt::UserRole).toString().trimmed() : QString();
  };

  auto camera_display_name = [](const QString& ip, const QString& model, const QString& sn) {
    if (!model.trimmed().isEmpty()) {
      return sn.trimmed().isEmpty() ? model.trimmed() : model.trimmed() + "\n" + sn.trimmed();
    }
    return ip;
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
      if (profile_camera_ip_at(row) == ip) {
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
    const QString model = camera.value("model").toString();
    const QString sn = camera.value("sn").toString();
    set_cell(profile_camera_table, row, 0, camera.value("name").toString(camera_display_name(ip, model, sn)));
    profile_camera_table->item(row, 0)->setData(Qt::UserRole, ip);
    profile_camera_table->item(row, 0)->setToolTip(ip);
    set_cell(profile_camera_table, row, 1, ip);
    set_cell(profile_camera_table, row, 2, camera.value("enabled").toBool(true) ? zh(u8"是") : zh(u8"否"));
    set_cell(profile_camera_table, row, 3, model);
    set_cell(profile_camera_table, row, 4, sn);
    set_cell(profile_camera_table, row, 5, camera.value("paramSource").toString(camera.value("useDeviceParams").toBool(false) ? "device" : "file"));
    set_cell(profile_camera_table, row, 6, camera.value("paramFile").toString(camera_param_path_for_ip(ip)));
    set_cell(profile_camera_table, row, 7, QString::number(params.value("exposureTime").toInt(exposure->value())));
    set_cell(profile_camera_table, row, 8, QString::number(params.value("gainK").toDouble(gain->value()), 'f', 3));
    set_cell(profile_camera_table, row, 9, QString::number(params.value("timeTriggerFreq").toDouble(trigger_freq->value()), 'f', 2));
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
        {"name", camera_display_name(ip, edit_camera_model->text().trimmed(), edit_camera_sn->text().trimmed())},
        {"paramSource", edit_camera_param_source->currentData().toString()},
        {"useDeviceParams", edit_camera_param_source->currentData().toString() == "device"},
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
      const QString ip = profile_camera_ip_at(row);
      if (ip.isEmpty() || ip == "-") {
        continue;
      }
      const QString enabled_text = profile_camera_table->item(row, 2) ? profile_camera_table->item(row, 2)->text().trimmed() : zh(u8"是");
      const QString source_text = profile_camera_table->item(row, 5) ? profile_camera_table->item(row, 5)->text().trimmed() : "device";
      const int exposure_value = profile_camera_table->item(row, 7) ? profile_camera_table->item(row, 7)->text().toInt() : exposure->value();
      const double gain_value = profile_camera_table->item(row, 8) ? profile_camera_table->item(row, 8)->text().toDouble() : gain->value();
      const double trigger_value = profile_camera_table->item(row, 9) ? profile_camera_table->item(row, 9)->text().toDouble() : trigger_freq->value();
      cameras.append(QJsonObject{
          {"ip", ip},
          {"enabled", enabled_text != zh(u8"否") && enabled_text != "false" && enabled_text != "0"},
          {"name", profile_camera_table->item(row, 0) ? profile_camera_table->item(row, 0)->text() : ip},
          {"model", profile_camera_table->item(row, 3) ? profile_camera_table->item(row, 3)->text() : ""},
          {"sn", profile_camera_table->item(row, 4) ? profile_camera_table->item(row, 4)->text() : ""},
          {"paramSource", source_text.isEmpty() ? "device" : source_text},
          {"useDeviceParams", source_text != "file"},
          {"paramFile", profile_camera_table->item(row, 6) ? profile_camera_table->item(row, 6)->text() : camera_param_path_for_ip(ip)},
          {"params", QJsonObject{
                         {"exposureTime", exposure_value},
                         {"gainK", gain_value},
                         {"timeTriggerFreq", trigger_value},
                     }},
      });
    }
    return cameras;
  };

  auto profile_file_camera_ips = [&]() {
    QJsonArray ips;
    for (int row = 0; row < profile_camera_table->rowCount(); ++row) {
      const QString ip = profile_camera_ip_at(row);
      const QString source_text = profile_camera_table->item(row, 5) ? profile_camera_table->item(row, 5)->text().trimmed() : "device";
      if (!ip.isEmpty() && source_text == "file") {
        ips.append(ip);
      }
    }
    return ips;
  };

  auto profile_camera_files_array = [&]() {
    QJsonArray files;
    for (int row = 0; row < profile_camera_table->rowCount(); ++row) {
      const QString ip = profile_camera_ip_at(row);
      const QString source_text = profile_camera_table->item(row, 5) ? profile_camera_table->item(row, 5)->text().trimmed() : "device";
      const QString file = profile_camera_table->item(row, 6) ? profile_camera_table->item(row, 6)->text().trimmed() : "";
      if (!ip.isEmpty() && source_text == "file" && !file.isEmpty() && file != "-") {
        files.append(QJsonObject{{"ip", ip}, {"path", file}});
      }
    }
    return files;
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

  auto profile_object_for_submit = [&]() {
    QJsonObject profile = profile_object_from_editor();
    if (profile.isEmpty()) {
      return profile;
    }
    const QString startup_mode = profile_startup_mode->currentData().toString();
    const QJsonArray file_ips = profile_file_camera_ips();
    profile.insert("name", profile_name->text().trimmed().isEmpty() ? profile.value("name").toString("default") : profile_name->text().trimmed());
    profile.insert("updatedAt", QDateTime::currentDateTime().toString(Qt::ISODateWithMs));
    profile.insert("driverMode", profile_driver_mode->currentData().toString());
    profile.insert("storageRoot", storage_root->text().trimmed());
    profile.insert("cameraParamDir", profile_camera_param_dir->text().trimmed());
    profile.insert("startupMode", startup_mode);
    profile.insert("autoConnect", profile_auto_connect->isChecked());
    profile.insert("expectedCameras", profile_expected_cameras->value());
    profile.insert("changeStorage", profile_change_storage->isChecked());
    profile.insert("loadCameraParams", profile_load_camera_params->isChecked() && !file_ips.isEmpty());
    profile.insert("saveToDevice", profile_save_to_device->isChecked());
    profile.insert("cameras", profile_cameras_from_table());
    return profile;
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
            {"name", camera_display_name(ip,
                                         camera_table->item(row, 1) ? camera_table->item(row, 1)->text() : "",
                                         camera_table->item(row, 2) ? camera_table->item(row, 2)->text() : "")},
            {"model", camera_table->item(row, 1) ? camera_table->item(row, 1)->text() : ""},
            {"sn", camera_table->item(row, 2) ? camera_table->item(row, 2)->text() : ""},
            {"enabled", true},
            {"paramSource", "device"},
            {"useDeviceParams", true},
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
        {"loadCameraParams", profile_load_camera_params->isChecked() && !profile_file_camera_ips().isEmpty()},
        {"saveToDevice", profile_save_to_device->isChecked()},
        {"lines", lines->value()},
        {"width", width->value()},
        {"timeoutMs", timeout_ms->value()},
        {"dataMode", data_mode->currentData().toInt()},
        {"fpsLimit", fps_limit->value()},
        {"controlMode", 0},
        {"triggerInputType", 4},
        {"divRatio", 4},
        {"timeTriggerFreq", trigger_freq->value()},
        {"exposureTime", exposure->value()},
        {"gainK", gain->value()},
        {"cameraDefaults", QJsonObject{
                               {"controlMode", 0},
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

  auto update_profile_indicators = [&]() {
    const bool sdk_mode = profile_driver_mode->currentData().toString() == "lvm";
    set_status_dot(profile_driver_dot, sdk_mode ? QColor("#34d399") : QColor("#60a5fa"));
    set_status_dot(profile_auto_dot, profile_auto_connect->isChecked() ? QColor("#34d399") : QColor("#d6a238"));
    set_status_dot(profile_param_dot, profile_load_camera_params->isChecked() ? QColor("#34d399") : QColor("#4b626b"));
    set_status_dot(profile_device_dot, profile_save_to_device->isChecked() ? QColor("#ef6b5b") : QColor("#34d399"));
    set_status_dot(profile_storage_dot, profile_change_storage->isChecked() ? QColor("#d6a238") : QColor("#34d399"));
    QString hint = sdk_mode ? zh(u8"真实 SDK") : zh(u8"离线模拟");
    hint += profile_auto_connect->isChecked() ? zh(u8" | 自动连接") : zh(u8" | 手动连接");
    hint += profile_load_camera_params->isChecked() ? zh(u8" | 加载参数") : zh(u8" | 不加载参数");
    hint += profile_save_to_device->isChecked() ? zh(u8" | 将写入设备") : zh(u8" | 不写设备");
    hint += profile_change_storage->isChecked() ? zh(u8" | 会切换存储") : zh(u8" | 保持存储");
    set_value(profile_state_hint, hint);
  };

  auto mark_profile_dirty = [&]() {
    if (!profile_editor_loading) {
      profile_editor_dirty = true;
    }
    update_profile_indicators();
  };

  QObject::connect(profile_driver_mode, &QComboBox::currentTextChanged, [&](const QString&) { mark_profile_dirty(); });
  QObject::connect(profile_load_camera_params, &QCheckBox::toggled, [&](bool) { mark_profile_dirty(); });
  QObject::connect(profile_save_to_device, &QCheckBox::toggled, [&](bool) { mark_profile_dirty(); });
  QObject::connect(profile_change_storage, &QCheckBox::toggled, [&](bool) { mark_profile_dirty(); });
  QObject::connect(profile_name, &QLineEdit::textEdited, [&](const QString&) { mark_profile_dirty(); });
  QObject::connect(profile_camera_param_dir, &QLineEdit::textEdited, [&](const QString&) { mark_profile_dirty(); });
  QObject::connect(profile_expected_cameras, static_cast<void (QSpinBox::*)(int)>(&QSpinBox::valueChanged),
                   [&](int) { mark_profile_dirty(); });
  QObject::connect(profile_json, &QPlainTextEdit::textChanged, [&]() { mark_profile_dirty(); });
  update_profile_indicators();

  auto normalized_startup_mode = [&](const QJsonObject& profile) {
    QString startup_mode = profile.value("startupMode").toString();
    const bool profile_auto_connect_value = profile.value("autoConnect").toBool(false);
    if (startup_mode == "auto-connect-continuous") {
      startup_mode = "auto-connect";
    }
    if (startup_mode.isEmpty() || (startup_mode == "manual" && profile_auto_connect_value)) {
      startup_mode = profile_auto_connect_value ? "auto-connect" : "manual";
    }
    return startup_mode == "auto-connect" ? QString("auto-connect") : QString("manual");
  };

  auto update_profile_json_startup_fields = [&](const QString& startup_mode, bool auto_connect) {
    if (profile_editor_loading || profile_json->toPlainText().trimmed().isEmpty()) {
      return;
    }
    QJsonParseError parse_error{};
    const QJsonDocument doc = QJsonDocument::fromJson(profile_json->toPlainText().toUtf8(), &parse_error);
    if (parse_error.error != QJsonParseError::NoError || !doc.isObject()) {
      return;
    }
    QJsonObject profile = doc.object();
    profile.insert("startupMode", startup_mode);
    profile.insert("autoConnect", auto_connect);
    profile_editor_loading = true;
    profile_json->setPlainText(QString::fromUtf8(QJsonDocument(profile).toJson(QJsonDocument::Indented)));
    profile_editor_loading = false;
  };

  bool profile_startup_syncing = false;
  QObject::connect(profile_startup_mode, static_cast<void (QComboBox::*)(int)>(&QComboBox::currentIndexChanged),
                   [&](int) {
                     if (profile_editor_loading || profile_startup_syncing) {
                       update_profile_indicators();
                       return;
                     }
                     const QString startup_mode = profile_startup_mode->currentData().toString() == "auto-connect" ? "auto-connect" : "manual";
                     const bool auto_connect = startup_mode == "auto-connect";
                     profile_startup_syncing = true;
                     {
                       QSignalBlocker blocker(profile_auto_connect);
                       profile_auto_connect->setChecked(auto_connect);
                     }
                     profile_startup_syncing = false;
                     update_profile_json_startup_fields(startup_mode, auto_connect);
                     mark_profile_dirty();
                   });
  QObject::connect(profile_auto_connect, &QCheckBox::toggled, [&](bool checked) {
    if (profile_editor_loading || profile_startup_syncing) {
      update_profile_indicators();
      return;
    }
    const QString startup_mode = checked ? "auto-connect" : "manual";
    const int index = profile_startup_mode->findData(startup_mode);
    profile_startup_syncing = true;
    if (index >= 0) {
      QSignalBlocker blocker(profile_startup_mode);
      profile_startup_mode->setCurrentIndex(index);
    }
    profile_startup_syncing = false;
    update_profile_json_startup_fields(startup_mode, checked);
    mark_profile_dirty();
  });

  auto render_profile_object = [&](const QJsonObject& profile) {
    profile_editor_loading = true;
    QJsonObject normalized_profile = profile;
    const QString startup_mode = normalized_startup_mode(normalized_profile);
    const bool startup_auto_connect = startup_mode == "auto-connect";
    normalized_profile.insert("startupMode", startup_mode);
    normalized_profile.insert("autoConnect", startup_auto_connect);
    profile_json->setPlainText(QString::fromUtf8(QJsonDocument(normalized_profile).toJson(QJsonDocument::Indented)));
    if (normalized_profile.contains("name")) {
      profile_name->setText(normalized_profile.value("name").toString("default"));
    }
    if (normalized_profile.contains("storageRoot")) {
      storage_root->setText(normalized_profile.value("storageRoot").toString(storage_root->text()));
    }
    if (normalized_profile.contains("driverMode")) {
      const int index = profile_driver_mode->findData(normalized_profile.value("driverMode").toString("lvm"));
      if (index >= 0) {
        profile_driver_mode->setCurrentIndex(index);
      }
    }
    if (normalized_profile.contains("cameraParamDir")) {
      profile_camera_param_dir->setText(normalized_profile.value("cameraParamDir").toString("config/camera-params/default"));
    }
    const int startup_index = profile_startup_mode->findData(startup_mode);
    if (startup_index >= 0) {
      profile_startup_mode->setCurrentIndex(startup_index);
    }
    profile_auto_connect->setChecked(startup_auto_connect);
    if (normalized_profile.contains("loadCameraParams")) profile_load_camera_params->setChecked(normalized_profile.value("loadCameraParams").toBool());
    if (normalized_profile.contains("saveToDevice")) profile_save_to_device->setChecked(normalized_profile.value("saveToDevice").toBool());
    if (normalized_profile.contains("changeStorage")) profile_change_storage->setChecked(normalized_profile.value("changeStorage").toBool());
    if (normalized_profile.contains("expectedCameras")) profile_expected_cameras->setValue(normalized_profile.value("expectedCameras").toInt(6));
    update_profile_indicators();
    profile_camera_table->setRowCount(0);
    const QJsonArray cameras = normalized_profile.value("cameras").toArray();
    for (const QJsonValue& value : cameras) {
      const QJsonObject camera = value.toObject();
      const QString ip = camera.value("ip").toString().trimmed();
      if (ip.isEmpty()) {
        continue;
      }
      set_profile_camera_row(profile_camera_row_for_ip(ip), camera);
    }
    profile_editor_dirty = false;
    profile_editor_loading = false;
  };

  auto render_profile_entries = [&](const QJsonObject& status) {
    profile_list_refreshing = true;
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
    profile_list_refreshing = false;
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
    set_cell(continuous_table, row, 6, stats.error_name);
    set_cell(continuous_table, row, 7, stats.complete_frame ? zh(u8"是") : zh(u8"否"));
    set_cell(continuous_table, row, 8, stats.depth_exists ? zh(u8"是") : zh(u8"否"));
    set_cell(continuous_table, row, 9, stats.intensity_exists ? zh(u8"是") : zh(u8"否"));
    set_cell(continuous_table, row, 10, stats.metadata_exists ? zh(u8"是") : zh(u8"否"));
    set_cell(continuous_table, row, 11, stats.latest_output);
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

  auto render_overview = [&]() {
    const bool sdk_ready = overview_health_state.value("sdkReady").toBool(false);
    const QString driver_mode = overview_health_state.value("driverMode").toString("-");
    const QString driver_id = overview_health_state.value("driverId").toString("-");
    set_value(overview_api, origin);
    set_value(overview_sdk, QString("%1 | %2 | code %3")
                                .arg(sdk_ready ? zh(u8"就绪") : zh(u8"未就绪"))
                                .arg(driver_mode + "/" + driver_id)
                                .arg(overview_health_state.value("sdkCode").toInt()));
    set_value(overview_storage, overview_storage_state.value("root").toString(
                                    overview_health_state.value("storageRoot").toString("-")));
    set_value(overview_profile, overview_config_state.value("activeProfile").toString("-"));

    QStringList ips = overview_discovered_ips;
    for (const auto& entry : overview_status_by_ip) {
      if (!ips.contains(entry.first)) {
        ips.append(entry.first);
      }
    }
    ips.sort();

    int connected_count = 0;
    int streaming_count = 0;
    int abnormal_count = sdk_ready ? 0 : 1;
    int complete_count = 0;
    int capture_fail_count = 0;
    int trigger_time_count = 0;
    int trigger_line_count = 0;
    int fps_source_count = 0;
    int total_stream_frames = 0;
    double fps_sum = 0.0;
    QStringList trigger_freqs;
    QStringList data_modes;
    for (const QString& ip : ips) {
      const QJsonObject status = overview_status_by_ip.count(ip) ? overview_status_by_ip[ip] : QJsonObject{};
      const bool connected = status.value("connected").toBool(false);
      const bool streaming = status.value("streamRunning").toBool(false);
      const QJsonObject config = status.value("captureConfig").toObject();
      const int trigger_source = config.value("triggerInputType").toInt(-1);
      const int trigger_lines = config.value("triggerLines").toInt(-1);
      const bool config_ok = config.value("controlMode").toInt(-1) == 0 &&
                             trigger_source == 4 &&
                             trigger_lines == 1000;
      if (connected) {
        connected_count += 1;
      }
      if (streaming) {
        streaming_count += 1;
      }
      if (connected && trigger_source == 4) {
        trigger_time_count += 1;
      }
      if (connected && trigger_lines == 1000) {
        trigger_line_count += 1;
      }
      if (connected) {
        const QString freq = QString::number(config.value("timeTriggerFreq").toDouble(0.0), 'f', 2);
        if (!trigger_freqs.contains(freq)) {
          trigger_freqs.append(freq);
        }
        const QString data_mode_text = QString::number(config.value("captureDataType").toInt(-1));
        if (!data_modes.contains(data_mode_text)) {
          data_modes.append(data_mode_text);
        }
      }
      double camera_fps = status.value("fps").toDouble(-1.0);
      if (ip == active_stream_ip) {
        camera_fps = measured_fps;
      }
      if (camera_fps >= 0.0) {
        fps_sum += camera_fps;
        fps_source_count += 1;
      }
      total_stream_frames += status.value("streamFrames").toInt();
      if (connected && !config_ok) {
        abnormal_count += 1;
      }
      const auto stats = continuous_stats.find(ip);
      if (stats != continuous_stats.end()) {
        if (stats->second.complete_frame) {
          complete_count += 1;
        }
        if (stats->second.failures > 0 || (stats->second.last_code != 0 && stats->second.error_name != "-")) {
          capture_fail_count += 1;
        }
      }
    }
    abnormal_count += capture_fail_count;
    set_value(overview_counts, QString(zh(u8"发现 %1 | 连接 %2/6 | 预览 %3 | 异常 %4"))
                                   .arg(ips.size())
                                   .arg(connected_count)
                                   .arg(streaming_count)
                                   .arg(abnormal_count));
    trigger_freqs.sort();
    data_modes.sort();
    set_value(overview_trigger, QString(zh(u8"时间触发 %1/%2 | 1000 行 %3/%4 | 频率 %5 Hz | 数据模式 %6"))
                                    .arg(trigger_time_count)
                                    .arg(connected_count)
                                    .arg(trigger_line_count)
                                    .arg(connected_count)
                                    .arg(trigger_freqs.isEmpty() ? "-" : trigger_freqs.join("/"))
                                    .arg(data_modes.isEmpty() ? "-" : data_modes.join("/")));
    const double avg_fps = fps_source_count > 0 ? fps_sum / static_cast<double>(fps_source_count) : 0.0;
    set_value(overview_fps, QString(zh(u8"预览运行 %1 台 | 当前 %2 | 平均 FPS %3 | 流帧数 %4"))
                                .arg(streaming_count)
                                .arg(active_stream_ip.isEmpty() ? "-" : active_stream_ip)
                                .arg(avg_fps, 0, 'f', 1)
                                .arg(total_stream_frames));

    QString system_state = zh(u8"待机");
    if (!sdk_ready) {
      system_state = zh(u8"SDK 离线");
    } else if (abnormal_count > 0) {
      system_state = zh(u8"异常待处理");
    } else if (continuous_running) {
      system_state = zh(u8"测试运行中");
    } else if (overview_steel_state.value("present").toBool(false)) {
      system_state = zh(u8"进钢采集中");
    } else if (streaming_count > 0) {
      system_state = zh(u8"预览监控中");
    } else if (connected_count >= 6) {
      system_state = zh(u8"6 相机就绪");
    } else if (connected_count > 0) {
      system_state = zh(u8"部分相机就绪");
    }
    set_value(overview_system,
              QString(zh(u8"%1 | 连接 %2/6 | 预览 %3 | 异常 %4"))
                  .arg(system_state)
                  .arg(connected_count)
                  .arg(streaming_count)
                  .arg(abnormal_count));

    const QString steel_phase = overview_steel_state.value("phase").toString("idle");
    QString steel_phase_text = zh(u8"待进钢");
    if (steel_phase == "steel-in") {
      steel_phase_text = zh(u8"进钢采集中");
    } else if (steel_phase == "steel-out") {
      steel_phase_text = zh(u8"出钢收尾");
    } else if (steel_phase == "info-ready") {
      steel_phase_text = zh(u8"钢板信息已就绪");
    }
    const QString steel_id = overview_steel_state.value("steelId").toString("-");
    const QString steel_type = overview_steel_state.value("steelType").toString("-");
    set_value(overview_steel,
              QString(zh(u8"%1 | 钢板 %2 | 钢种 %3 | 长 %4 宽 %5 厚 %6 | 更新时间 %7"))
                  .arg(steel_phase_text)
                  .arg(steel_id.isEmpty() ? "-" : steel_id)
                  .arg(steel_type.isEmpty() ? "-" : steel_type)
                  .arg(overview_steel_state.value("length").toDouble(), 0, 'f', 1)
                  .arg(overview_steel_state.value("width").toDouble(), 0, 'f', 1)
                  .arg(overview_steel_state.value("thickness").toDouble(), 0, 'f', 1)
                  .arg(overview_steel_state.value("updatedAt").toString("-")));
    set_value(overview_session,
              QString(zh(u8"会话 %1 | 采集 %2 成功 %3 失败 %4 | 最新 %5 | 目录 %6"))
                  .arg(overview_steel_state.value("sessionId").toString("-").isEmpty()
                           ? "-"
                           : overview_steel_state.value("sessionId").toString("-"))
                  .arg(overview_steel_state.value("captureCount").toInt())
                  .arg(overview_steel_state.value("captureSuccessCount").toInt())
                  .arg(overview_steel_state.value("captureFailureCount").toInt())
                  .arg(overview_steel_state.value("lastCaptureOutput").toString("-").isEmpty()
                           ? "-"
                           : overview_steel_state.value("lastCaptureOutput").toString("-"))
                  .arg(overview_steel_state.value("captureDir").toString("-").isEmpty()
                           ? "-"
                           : overview_steel_state.value("captureDir").toString("-")));

    const int summary_successes = overview_last_summary.value("successes").toInt(-1);
    if (summary_successes >= 0) {
      set_value(overview_last_capture,
                QString(zh(u8"成功 %1 | 失败 %2 | 完整帧 %3 | 元数据 %4"))
                    .arg(summary_successes)
                    .arg(overview_last_summary.value("failures").toInt())
                    .arg(overview_last_summary.value("completeFrames").toInt())
                    .arg(overview_last_summary.value("metadataFrames").toInt()));
    } else if (complete_count > 0) {
      set_value(overview_last_capture, QString(zh(u8"最近测试完整帧 %1")).arg(complete_count));
    } else {
      set_value(overview_last_capture, zh(u8"尚未采集"));
    }

    for (int i = 0; i < static_cast<int>(overview_cards.size()); ++i) {
      OverviewCard& card = overview_cards[i];
      const QString ip = i < ips.size() ? ips.at(i) : QString();
      card.ip = ip;
      card.frame->setProperty("ip", ip);
      card.jump->setEnabled(!ip.isEmpty());
      if (ip.isEmpty()) {
        card.title->setText(QString(zh(u8"相机槽位 %1")).arg(i + 1));
        card.subtitle->setText(zh(u8"等待发现"));
        set_value(card.state, "-");
        set_value(card.config, "-");
        set_value(card.capture, "-");
        set_value(card.output, "-");
        card.frame->setStyleSheet("QFrame#overviewCard { background: #171a16; border: 1px solid #3f3a24; border-radius: 6px; }");
        continue;
      }

      const QJsonObject status = overview_status_by_ip.count(ip) ? overview_status_by_ip[ip] : QJsonObject{};
      const QJsonObject config = status.value("captureConfig").toObject();
      const bool connected = status.value("connected").toBool(false);
      const bool streaming = status.value("streamRunning").toBool(false);
      const bool config_ok = config.value("controlMode").toInt(-1) == 0 &&
                             config.value("triggerInputType").toInt(-1) == 4 &&
                             config.value("triggerLines").toInt(-1) == 1000;
      const auto stats = continuous_stats.find(ip);
      const ContinuousStats capture = stats == continuous_stats.end() ? ContinuousStats{} : stats->second;
      const bool capture_error = capture.failures > 0 || (capture.last_code != 0 && capture.error_name != "-");
      const bool sdk_error = status.value("sdkStatus").toString().contains("error", Qt::CaseInsensitive);
      double camera_fps = status.value("fps").toDouble(-1.0);
      if (ip == active_stream_ip) {
        camera_fps = measured_fps;
      }
      const QString fps_text = camera_fps >= 0.0 ? QString::number(camera_fps, 'f', 1) : "-";

      card.title->setText(ip);
      card.subtitle->setText(QString("%1 | SN %2")
                                 .arg(status.value("model").toString("-"))
                                 .arg(status.value("sn").toString("-")));
      set_value(card.state, QString(zh(u8"连接 %1 | SDK %2 | 采集 %3 | 预览 %4 | FPS %5 | 帧 %6"))
                                .arg(connected ? zh(u8"已连接") : zh(u8"未连接"))
                                .arg(status.value("sdkStatus").toString("-"))
                                .arg(status.value("acquisitionState").toString("-"))
                                .arg(streaming ? zh(u8"运行中") : zh(u8"停止"))
                                .arg(fps_text)
                                .arg(status.value("streamFrames").toInt()));
      set_value(card.config, QString("mode %1 | trigger %2(%3) | lines %4 | data %5 | freq %6Hz | exp %7 | gain %8 | laser %9 | array %10 | power %11")
                                 .arg(config.value("controlMode").toInt(-1))
                                 .arg(config.value("triggerInputType").toInt(-1))
                                 .arg(config.value("triggerSourceLabel").toString("-"))
                                 .arg(config.value("triggerLines").toInt(-1))
                                 .arg(config.value("captureDataType").toInt(-1))
                                 .arg(config.value("timeTriggerFreq").toDouble(0.0), 0, 'f', 2)
                                 .arg(config.value("exposureTime").toInt(-1))
                                 .arg(config.value("gainK").toDouble(0.0), 0, 'f', 3)
                                 .arg(config.value("laserEnable").toInt(-1))
                                 .arg(config.value("arrayEnable").toInt(-1))
                                 .arg(config.value("laserPower").toInt(-1)));
      set_value(card.capture, QString(zh(u8"采集 code %1 | %2 | 完整 %3 | 深度 %4 | 亮度 %5 | 元数据 %6"))
                                  .arg(capture.last_code)
                                  .arg(capture.error_name)
                                  .arg(capture.complete_frame ? zh(u8"是") : zh(u8"否"))
                                  .arg(capture.depth_exists ? zh(u8"是") : zh(u8"否"))
                                  .arg(capture.intensity_exists ? zh(u8"是") : zh(u8"否"))
                                  .arg(capture.metadata_exists ? zh(u8"是") : zh(u8"否")));
      set_value(card.output, capture.latest_output);

      QString color = "#142d20";
      QString border = "#2f7d51";
      if (streaming) {
        color = "#103d47";
        border = "#2e8798";
      } else if (!connected || capture.attempts == 0) {
        color = "#2a2416";
        border = "#6a5620";
      }
      if (!config_ok || sdk_error || capture_error) {
        color = "#2a1719";
        border = "#9d4a4a";
      }
      card.frame->setStyleSheet(QString("QFrame#overviewCard { background: %1; border: 1px solid %2; border-radius: 6px; }")
                                    .arg(color, border));
    }
  };

  std::function<void(std::function<void(QStringList)>)> fetch_discovered_ips =
      [&](std::function<void(QStringList)> done) {
        request_json(network, "GET", origin + "/api/cameras", {}, continuous_log,
                     [&, done = std::move(done)](const QJsonObject& json) {
                       QStringList ips;
                       const QJsonArray cameras = json.value("cameras").toArray();
                       overview_discovered_ips.clear();
                       for (const QJsonValue& value : cameras) {
                         const QJsonObject camera = value.toObject();
                         const QString ip = camera.value("ip").toString().trimmed();
                         if (ip.isEmpty() || ips.contains(ip)) {
                           continue;
                         }
                         ips.append(ip);
                         overview_discovered_ips.append(ip);
                         const int row = find_or_add_row(camera_table, ip);
                         set_cell(camera_table, row, 1, camera.value("model").toString());
                         set_cell(camera_table, row, 2, camera.value("sn").toString());
                         set_cell(camera_table, row, 3, camera.value("driverId").toString());
                         set_cell(camera_table, row, 7, zh(u8"已发现"));
                         apply_camera_row_style(row, false, false, "discovered");
                       }
                       update_camera_selection_markers();
                       render_overview();
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

  std::function<void()> refresh_all;

  std::function<void()> refresh_health = [&]() {
    request_json(network, "GET", origin + "/health", {}, log, [&](const QJsonObject& json) {
      overview_health_state = json;
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
      render_overview();
    });
  };

  std::function<void()> refresh_storage = [&]() {
    request_json(network, "GET", origin + "/api/storage/status", {}, log, [&](const QJsonObject& json) {
      overview_storage_state = json;
      if (json.contains("root")) {
        storage_root->setText(json.value("root").toString());
      }
      storage_status_text->setPlainText(json_to_text(json));
      render_overview();
    });
  };

  std::function<void()> refresh_config_status = [&]() {
    request_json(network, "GET", origin + "/api/config/status", {}, log, [&](const QJsonObject& json) {
      overview_config_state = json;
      profile_result->setPlainText(json_to_text(json));
      render_profile_entries(json);
      const QString active = json.value("activeProfile").toString();
      if (!active.isEmpty()) {
        profile_name->setText(active);
        if (!profile_editor_dirty) {
          request_json(network, "GET", origin + "/api/config/profile?name=" + encoded(active), {}, log,
                       [&](const QJsonObject& profile) {
                         if (!profile_editor_dirty) {
                           render_profile_object(profile);
                         }
                       });
        }
      } else if (profile_json->toPlainText().trimmed().isEmpty()) {
        render_profile_object(build_profile_object());
      }
      render_overview();
    });
  };

  std::function<void()> refresh_cameras = [&]() {
    request_json(network, "GET", origin + "/api/cameras", {}, log, [&](const QJsonObject& json) {
      const QJsonArray cameras = json.value("cameras").toArray();
      overview_discovered_ips.clear();
      for (const QJsonValue& value : cameras) {
        const QJsonObject camera = value.toObject();
        const QString ip = camera.value("ip").toString();
        if (ip.isEmpty()) {
          continue;
        }
        if (!overview_discovered_ips.contains(ip)) {
          overview_discovered_ips.append(ip);
        }
        const int row = find_or_add_row(camera_table, ip);
        set_cell(camera_table, row, 1, camera.value("model").toString());
        set_cell(camera_table, row, 2, camera.value("sn").toString());
        set_cell(camera_table, row, 3, camera.value("driverId").toString());
        set_cell(camera_table, row, 7, zh(u8"已发现"));
        apply_camera_row_style(row, false, false, "discovered");
      }
      update_camera_selection_markers();
      render_overview();
    });
  };

  std::function<void()> refresh_statuses = [&]() {
    request_json(network, "GET", origin + "/api/camera/statuses", {}, log, [&](const QJsonObject& json) {
      const QJsonArray statuses = json.value("statuses").toArray();
      overview_status_by_ip.clear();
      for (const QJsonValue& value : statuses) {
        const QJsonObject status = value.toObject();
        const QString ip = status.value("ip").toString();
        if (ip.isEmpty()) {
          continue;
        }
        overview_status_by_ip[ip] = status;
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
      render_overview();
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
      render_overview();
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

  std::function<void()> refresh_active_calibration = [&]() {
    const QString active = overview_config_state.value("activeProfile").toString(profile_name->text().trimmed().isEmpty() ? "current-6-soft-trigger" : profile_name->text().trimmed());
    request_json(network, "GET", origin + "/api/calibration/active?profile=" + encoded(active), {}, calibration_log,
                 [&](const QJsonObject& json) {
                   calibration_active_state = json;
                   calibration_log->setPlainText(json_to_text(json));
                   if (json_code(json) != 0) {
                     log_line(calibration_log, QString(zh(u8"当前标定读取失败：%1")).arg(json.value("error").toString()));
                     return;
                   }
                   const QJsonObject active_calibration = json.value("activeCalibration").toObject();
                   const QString calibration_file = json.value("calibrationFile").toString();
                   const QString fit_report = active_calibration.value("fitReport").toString();
                   const QString version = active_calibration.value("version").toString(QFileInfo(provider_local_path(calibration_file)).absolutePath());
                   const QJsonObject fit_after = active_calibration.value("fitAfter").toObject();
                   add_version_row(version.isEmpty() ? zh(u8"当前标定") : version,
                                   zh(u8"当前"),
                                   fit_after.isEmpty() ? "-" : QString("%1 mm").arg(fit_after.value("meanAbsResidual").toDouble(), 0, 'f', 4),
                                   QFileInfo(provider_local_path(calibration_file)).absolutePath());
                   if (!fit_report.isEmpty()) {
                     load_fit_report_file(provider_local_path(fit_report));
                   }
                 });
  };

  std::function<void()> refresh_steel_status = [&]() {
    request_json(network, "GET", origin + "/api/steel/status", {}, log, [&](const QJsonObject& json) {
      overview_steel_state = json;
      render_overview();
    });
  };

  refresh_all = [&]() {
    refresh_health();
    refresh_storage();
    refresh_config_status();
    refresh_steel_status();
    refresh_cameras();
    refresh_statuses();
    refresh_stream_status();
    refresh_calibration_status();
    refresh_active_calibration();
  };

  std::function<void()> auto_apply_startup_profile = [&]() {
    if (startup_profile_apply_attempted) {
      return;
    }
    startup_profile_apply_attempted = true;
    request_json(network, "GET", origin + "/api/config/status", {}, log,
                 [&](const QJsonObject& status) {
                   const QString active = status.value("activeProfile").toString();
                   if (active.trimmed().isEmpty()) {
                     log_line(log, zh(u8"启动自动应用跳过：没有 active profile。"));
                     return;
                   }
                   request_json(network, "GET", origin + "/api/config/profile?name=" + encoded(active), {}, log,
                                [&, active](const QJsonObject& profile) {
                                  if (normalized_startup_mode(profile) != "auto-connect") {
                                    log_line(log, QString(zh(u8"启动自动应用跳过：%1 为手动启动。")).arg(active));
                                    return;
                                  }
                                  const bool load_params = profile.value("loadCameraParams").toBool(false);
                                  QJsonObject body{
                                      {"name", active},
                                      {"autoConnect", true},
                                      {"loadCameraParams", load_params},
                                      {"saveToDevice", profile.value("saveToDevice").toBool(false)},
                                      {"changeStorage", profile.value("changeStorage").toBool(false)},
                                      {"expectedCameras", profile.value("expectedCameras").toInt(6)},
                                  };
                                  log_line(log, QString(zh(u8"启动自动应用配置：%1，自动连接 6 台，相机参数%2。"))
                                                    .arg(active)
                                                    .arg(load_params ? zh(u8"会加载") : zh(u8"不加载")));
                                  request_json(network, "POST", origin + "/api/config/profile/apply", body, log,
                                               [&](const QJsonObject& apply_json) {
                                                 log_line(log, QString(zh(u8"启动自动应用完成：返回码 %1，连接 %2，失败 %3。"))
                                                                   .arg(json_code(apply_json))
                                                                   .arg(apply_json.value("connected").toInt())
                                                                   .arg(apply_json.value("connectFailed").toInt()));
                                                 if (refresh_all) {
                                                   refresh_all();
                                                 }
                                               });
                                });
                 });
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
                   render_overview();
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
    overview_page_button->setEnabled(index != 0);
    preview_page_button->setEnabled(index != 1);
    config_page_button->setEnabled(index != 2);
    calibration_page_button->setEnabled(index != 3);
  };
  QObject::connect(overview_page_button, &QPushButton::clicked, [&]() {
    set_main_page(0);
    refresh_all();
  });
  QObject::connect(preview_page_button, &QPushButton::clicked, [&]() {
    set_main_page(1);
  });
  QObject::connect(config_page_button, &QPushButton::clicked, [&]() {
    set_main_page(2);
    refresh_config_status();
  });
  QObject::connect(calibration_page_button, &QPushButton::clicked, [&]() {
    set_main_page(3);
    refresh_active_calibration();
    refresh_calibration_status();
  });
  set_main_page(0);

  for (OverviewCard& card : overview_cards) {
    QPushButton* jump_button = card.jump;
    QObject::connect(jump_button, &QPushButton::clicked, [&, jump_button]() {
      QString ip;
      for (const OverviewCard& item : overview_cards) {
        if (item.jump == jump_button) {
          ip = item.ip;
          break;
        }
      }
      if (ip.isEmpty()) {
        return;
      }
      const int row = find_or_add_row(camera_table, ip);
      camera_table->selectRow(row);
      set_selection_ip(ip);
      set_main_page(1);
      camera_tabs->setCurrentIndex(0);
      start_stream->click();
    });
  }

  QObject::connect(overview_refresh, &QPushButton::clicked, [&]() {
    overview_log_line(zh(u8"总览刷新全部状态。"));
    refresh_all();
  });

  QObject::connect(overview_connect_all, &QPushButton::clicked, [&]() {
    request_json(network, "POST", origin + "/api/cameras/connect-all",
                 QJsonObject{{"expectedCameras", 6}, {"devType", -1}},
                 overview_log,
                 [&](const QJsonObject& json) {
                   overview_log_line(QString(zh(u8"自动连接完成：返回码 %1，发现 %2，连接 %3"))
                                         .arg(json_code(json))
                                         .arg(json.value("discovered").toInt())
                                         .arg(json.value("connected").toInt()));
                   refresh_all();
                 });
  });

  QObject::connect(overview_load_params, &QPushButton::clicked, [&]() {
    const QString active = overview_config_state.value("activeProfile").toString(profile_name->text().trimmed());
    QJsonObject body{
        {"name", active.isEmpty() ? "current-6-soft-trigger" : active},
        {"cameraParamDir", profile_camera_param_dir->text().trimmed()},
        {"applySoftTrigger", false},
        {"saveToDevice", false},
    };
    request_json(network, "POST", origin + "/api/config/camera-params/load-all", body, overview_log,
                 [&](const QJsonObject& json) {
                   overview_log_line(QString(zh(u8"当前配置参数加载完成：返回码 %1，成功 %2，失败 %3"))
                                         .arg(json_code(json))
                                         .arg(json.value("loaded").toInt(json.value("applied").toInt()))
                                         .arg(json.value("failed").toInt()));
                   refresh_all();
                 });
  });

  QObject::connect(overview_stop_streams, &QPushButton::clicked, [&]() {
    QStringList ips = overview_discovered_ips;
    for (const auto& entry : overview_status_by_ip) {
      if (!ips.contains(entry.first)) {
        ips.append(entry.first);
      }
    }
    if (ips.isEmpty()) {
      overview_log_line(zh(u8"没有可停止预览的相机。"));
      return;
    }
    for (const QString& ip : ips) {
      request_json(network, "POST", origin + "/api/stream/stop", QJsonObject{{"ip", ip}}, overview_log,
                   [&, ip](const QJsonObject& json) {
                     overview_log_line(QString(zh(u8"停止预览 %1，返回码 %2")).arg(ip).arg(json_code(json)));
                     if (active_stream_ip == ip) {
                       active_stream_ip.clear();
                       preview_timer->stop();
                     }
                     refresh_statuses();
                   });
    }
  });

  std::function<void(bool, QPlainTextEdit*)> send_steel_presence_event = [&](bool present, QPlainTextEdit* target_log) {
    request_json(network, "POST", origin + "/api/steel/event",
                 QJsonObject{{"cmd", "steelIn"}, {"value", present ? 1 : 0}},
                 target_log ? target_log : overview_log,
                 [&, present, target_log](const QJsonObject& json) {
                   overview_steel_state = json;
                   const QString message = QString(present ? zh(u8"进钢事件已写入：返回码 %1")
                                                           : zh(u8"出钢事件已写入：返回码 %1"))
                                               .arg(json_code(json));
                   if (target_log == continuous_log) {
                     continuous_log_line(message);
                   } else {
                     overview_log_line(message);
                   }
                   render_overview();
                 });
  };

  QObject::connect(overview_steel_in, &QPushButton::clicked, [&]() {
    send_steel_presence_event(true, overview_log);
  });

  QObject::connect(overview_steel_out, &QPushButton::clicked, [&]() {
    send_steel_presence_event(false, overview_log);
  });

  std::function<void()> run_one_round_capture_test = [&]() {
    if (overview_one_round_running) {
      continuous_log_line(zh(u8"一轮完整采集测试正在运行。"));
      return;
    }
    QStringList ips = overview_discovered_ips;
    for (const auto& entry : overview_status_by_ip) {
      if (!ips.contains(entry.first)) {
        ips.append(entry.first);
      }
    }
    ips.sort();
    QString output_root = continuous_output_dir->text().trimmed();
    if (output_root.isEmpty()) {
      output_root = "continuous-test";
    }
    const QString output_dir = QString("%1/one-round-%2")
                                   .arg(output_root)
                                   .arg(QDateTime::currentDateTime().toString("yyyyMMdd-HHmmss"));
    QJsonObject body{
        {"expectedCameras", 6},
        {"rounds", 1},
        {"lines", 1000},
        {"width", 0},
        {"timeoutMs", 8000},
        {"intervalMs", 500},
        {"retries", 0},
        {"controlMode", 0},
        {"dataMode", 3},
        {"outputDir", output_dir},
        {"connectFirst", false},
        {"stopStreams", true},
    };
    if (!ips.isEmpty()) {
      QJsonArray ip_array;
      for (const QString& ip : ips) {
        ip_array.append(ip);
      }
      body.insert("ips", ip_array);
    }
    overview_one_round_running = true;
    continuous_log_line(zh(u8"开始一轮完整采集测试。"));
    request_json(network, "POST", origin + "/api/capture/continuous-test", body, continuous_log,
                 [&](const QJsonObject& json) {
                   overview_one_round_running = false;
                   overview_last_summary = json;
                   overview_last_summary_path = json.value("summaryOutput").toString();
                   const QJsonArray results = json.value("results").toArray();
                   for (const QJsonValue& value : results) {
                     const QJsonObject result = value.toObject();
                     const QString ip = result.value("ip").toString();
                     if (ip.isEmpty()) {
                       continue;
                     }
                     ContinuousStats& stats = continuous_stats[ip];
                     stats.attempts += 1;
                     stats.last_code = json_code(result);
                     stats.error_name = result.value("errorName").toString(stats.last_code == 0 ? "CORRECT" : "-");
                     stats.complete_frame = result.value("completeFrame").toBool(false);
                     stats.depth_exists = result.value("depthExists").toBool(false);
                     stats.intensity_exists = result.value("intensityExists").toBool(false);
                     stats.metadata_exists = result.value("metadataExists").toBool(false);
                     stats.latest_output = result.value("output").toString();
                     if (stats.last_code == 0) {
                       stats.successes += 1;
                     } else {
                       stats.failures += 1;
                     }
                     update_continuous_row(ip);
                   }
                  continuous_log_line(QString(zh(u8"一轮完整采集完成：返回码 %1，成功 %2，失败 %3，完整帧 %4，summary %5"))
                                          .arg(json_code(json))
                                          .arg(json.value("successes").toInt())
                                          .arg(json.value("failures").toInt())
                                          .arg(json.value("completeFrames").toInt())
                                          .arg(overview_last_summary_path));
                   refresh_all();
                   render_overview();
                 });
  };

  QObject::connect(overview_open_storage, &QPushButton::clicked, [&]() {
    const QString root_path = storage_root->text().trimmed().isEmpty()
                                  ? overview_storage_state.value("root").toString()
                                  : storage_root->text().trimmed();
    if (!root_path.isEmpty()) {
      QDesktopServices::openUrl(QUrl::fromLocalFile(root_path));
    }
  });

  QObject::connect(overview_open_steel_dir, &QPushButton::clicked, [&]() {
    const QString dir = overview_steel_state.value("captureDir").toString().trimmed();
    if (dir.isEmpty()) {
      overview_log_line(zh(u8"当前没有钢板采集目录。"));
      return;
    }
    QDesktopServices::openUrl(QUrl::fromLocalFile(dir));
  });

  QObject::connect(overview_open_summary, &QPushButton::clicked, [&]() {
    if (overview_last_summary_path.trimmed().isEmpty()) {
      const QString steel_summary = overview_steel_state.value("summaryOutput").toString().trimmed();
      if (steel_summary.isEmpty()) {
        overview_log_line(zh(u8"还没有可打开的 summary 文件。"));
        return;
      }
      QDesktopServices::openUrl(QUrl::fromLocalFile(steel_summary));
      return;
    }
    QDesktopServices::openUrl(QUrl::fromLocalFile(overview_last_summary_path));
  });

  std::function<void()> apply_line_preset_from_test = [&]() {
    if (QMessageBox::warning(&window,
                             zh(u8"确认应用线扫预设"),
                             zh(u8"此操作会把相机写入通用线扫预设，可能覆盖当前厂家配置2/时间触发参数。确认继续？"),
                             QMessageBox::Yes | QMessageBox::No,
                             QMessageBox::No) != QMessageBox::Yes) {
      continuous_log_line(zh(u8"已取消应用线扫预设。"));
      return;
    }
    QJsonObject body{
        {"lines", 1000},
        {"timeTriggerFreq", 300},
        {"laserPower", 100},
        {"laserLineSelect", 0},
        {"controlMode", 0},
        {"connectFirst", true},
        {"saveToDevice", false},
    };
    request_json(network, "POST", origin + "/api/capture/preset/line-continuous", body, continuous_log,
                 [&](const QJsonObject& json) {
                   continuous_log_line(QString(zh(u8"线扫预设应用完成：返回码 %1，成功 %2，失败 %3"))
                                           .arg(json_code(json))
                                           .arg(json.value("applied").toInt())
                                           .arg(json.value("failed").toInt()));
                   refresh_all();
                 });
  };

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
    if (profile_list_refreshing) {
      return;
    }
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
    edit_camera_ip->setText(profile_camera_ip_at(row));
    const QString enabled_text = profile_camera_table->item(row, 2) ? profile_camera_table->item(row, 2)->text().trimmed() : zh(u8"是");
    edit_camera_enabled->setChecked(enabled_text != zh(u8"否") && enabled_text != "false" && enabled_text != "0");
    edit_camera_model->setText(profile_camera_table->item(row, 3) ? profile_camera_table->item(row, 3)->text() : "");
    edit_camera_sn->setText(profile_camera_table->item(row, 4) ? profile_camera_table->item(row, 4)->text() : "");
    const QString source = profile_camera_table->item(row, 5) ? profile_camera_table->item(row, 5)->text().trimmed() : "device";
    const int source_index = edit_camera_param_source->findData(source == "file" ? "file" : "device");
    if (source_index >= 0) {
      edit_camera_param_source->setCurrentIndex(source_index);
    }
    edit_camera_param_file->setText(profile_camera_table->item(row, 6) ? profile_camera_table->item(row, 6)->text() : "");
    int camera_exposure = profile_camera_table->item(row, 7) ? profile_camera_table->item(row, 7)->text().toInt() : exposure->value();
    if (camera_exposure < 1) {
      camera_exposure = exposure->value();
    }
    edit_camera_exposure->setValue(camera_exposure);
    edit_camera_gain->setValue(profile_camera_table->item(row, 8) ? profile_camera_table->item(row, 8)->text().toDouble() : gain->value());
    edit_camera_trigger_freq->setValue(profile_camera_table->item(row, 9) ? profile_camera_table->item(row, 9)->text().toDouble() : trigger_freq->value());
  };

  QObject::connect(profile_camera_table, &QTableWidget::itemSelectionChanged, load_profile_camera_editor);

  auto update_camera_param_source_ui = [&]() {
    const bool use_file = edit_camera_param_source->currentData().toString() == "file";
    edit_camera_param_file->setEnabled(use_file);
    edit_camera_param_browse->setEnabled(use_file);
    edit_camera_load_file->setEnabled(use_file);
    if (!use_file) {
      camera_source_hint->setText(zh(u8"当前相机将使用相机内置/当前生效参数，不会从配置文件覆盖。"));
    } else {
      camera_source_hint->setText(zh(u8"当前相机将使用 .nccfg 配置文件，可点击“直接加载”立即应用到相机。"));
    }
  };
  QObject::connect(edit_camera_param_source, &QComboBox::currentTextChanged, [&](const QString&) { update_camera_param_source_ui(); });
  update_camera_param_source_ui();

  QObject::connect(edit_camera_param_browse, &QPushButton::clicked, [&]() {
    const QString ip = edit_camera_ip->text().trimmed();
    const QString base = edit_camera_param_file->text().trimmed().isEmpty() ? camera_param_path_for_ip(ip) : edit_camera_param_file->text().trimmed();
    const QString path = QFileDialog::getOpenFileName(&window, zh(u8"选择相机参数文件"), base, "NCCFG (*.nccfg);;All Files (*.*)");
    if (!path.isEmpty()) {
      edit_camera_param_file->setText(path);
      const int source_index = edit_camera_param_source->findData("file");
      if (source_index >= 0) {
        edit_camera_param_source->setCurrentIndex(source_index);
      }
    }
  });

  QObject::connect(edit_camera_use_device, &QPushButton::clicked, [&]() {
    const int source_index = edit_camera_param_source->findData("device");
    if (source_index >= 0) {
      edit_camera_param_source->setCurrentIndex(source_index);
    }
    const QString ip = edit_camera_ip->text().trimmed();
    if (!ip.isEmpty()) {
      const auto found = overview_status_by_ip.find(ip);
      if (found != overview_status_by_ip.end()) {
        const QJsonObject config = found->second.value("captureConfig").toObject();
        if (config.contains("exposureTime")) edit_camera_exposure->setValue(config.value("exposureTime").toInt(edit_camera_exposure->value()));
        if (config.contains("gainK")) edit_camera_gain->setValue(config.value("gainK").toDouble(edit_camera_gain->value()));
        if (config.contains("timeTriggerFreq")) edit_camera_trigger_freq->setValue(config.value("timeTriggerFreq").toDouble(edit_camera_trigger_freq->value()));
      }
    }
    log_line(log, zh(u8"当前相机已设置为使用内置/读回参数。"));
  });

  QObject::connect(edit_camera_load_file, &QPushButton::clicked, [&]() {
    const QString ip = edit_camera_ip->text().trimmed();
    const QString path = edit_camera_param_file->text().trimmed();
    if (ip.isEmpty() || path.isEmpty()) {
      log_line(log, zh(u8"请选择相机并填写参数文件。"));
      return;
    }
    request_json(network, "POST", origin + "/api/param/load-file",
                 QJsonObject{{"ip", ip},
                             {"path", path},
                             {"applySoftTrigger", false},
                             {"saveToDevice", profile_save_to_device->isChecked()},
                             {"allowExternal", true}},
                 log,
                 [&, ip](const QJsonObject& json) {
                   profile_result->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"相机配置文件已直接加载：%1，返回码 %2")).arg(ip).arg(json_code(json)));
                   refresh_all();
                 });
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
                                 {"name", camera_display_name(ip,
                                                              camera_table->item(row, 1) ? camera_table->item(row, 1)->text() : "",
                                                              camera_table->item(row, 2) ? camera_table->item(row, 2)->text() : "")},
                                 {"model", camera_table->item(row, 1) ? camera_table->item(row, 1)->text() : ""},
                                 {"sn", camera_table->item(row, 2) ? camera_table->item(row, 2)->text() : ""},
                                 {"paramSource", "device"},
                                 {"useDeviceParams", true},
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
    const QString ip = profile_camera_ip_at(row);
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
    QJsonObject profile = profile_object_for_submit();
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
    QJsonObject profile = profile_object_for_submit();
    if (profile.isEmpty()) {
      return;
    }
    const QString name = profile.value("name").toString(profile_name->text().trimmed());
    QJsonObject body{
        {"name", name.isEmpty() ? "default" : name},
        {"profileJson", QString::fromUtf8(QJsonDocument(profile).toJson(QJsonDocument::Compact))},
        {"autoConnect", profile_auto_connect->isChecked()},
        {"loadCameraParams", profile_load_camera_params->isChecked() && !profile_file_camera_ips().isEmpty()},
        {"saveToDevice", profile_save_to_device->isChecked()},
        {"changeStorage", profile_change_storage->isChecked()},
        {"expectedCameras", profile_expected_cameras->value()},
    };
    const QJsonArray file_ips = profile_file_camera_ips();
    const QJsonArray camera_files = profile_camera_files_array();
    if (!file_ips.isEmpty()) {
      body.insert("ips", file_ips);
    }
    if (!camera_files.isEmpty()) {
      body.insert("cameraFiles", camera_files);
      body.insert("allowExternal", true);
    }
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
    const QJsonArray file_ips = profile_file_camera_ips();
    const QJsonArray camera_files = profile_camera_files_array();
    if (file_ips.isEmpty()) {
      log_line(log, zh(u8"没有选择“使用配置文件”的相机；内置参数模式不需要加载文件。"));
      return;
    }
    QJsonObject body{
        {"name", profile_name->text().trimmed().isEmpty() ? "default" : profile_name->text().trimmed()},
        {"cameraParamDir", profile_camera_param_dir->text().trimmed()},
        {"applySoftTrigger", true},
        {"saveToDevice", profile_save_to_device->isChecked()},
        {"ips", file_ips},
        {"cameraFiles", camera_files},
        {"allowExternal", true},
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
      render_overview();
    });
  });

  QObject::connect(stop_stream, &QPushButton::clicked, [&]() {
    const QString ip = active_stream_ip.isEmpty() ? selected_or_log() : active_stream_ip;
    if (ip.isEmpty()) {
      return;
    }
    stop_stream_for_ip(ip, true);
    preview->setText(zh(u8"预览已停止"));
    render_overview();
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
        {"retries", continuous_retries->value()},
        {"controlMode", 0},
        {"output", output},
    };
    request_json(network, "POST", origin + "/api/capture/depth-map", body, continuous_log,
                 [&, ip, output](const QJsonObject& json) {
                   const int code = json_code(json);
                   ContinuousStats& item = continuous_stats[ip];
                   item.last_code = code;
                   item.error_name = json.value("errorName").toString(code == 0 ? "CORRECT" : "-");
                   item.complete_frame = json.value("completeFrame").toBool(false);
                   item.depth_exists = json.value("depthExists").toBool(false);
                   item.intensity_exists = json.value("intensityExists").toBool(false);
                   item.metadata_exists = json.value("metadataExists").toBool(false);
                   item.latest_output = json.value("output").toString(output);
                   if (code == 0) {
                     item.successes += 1;
                     continuous_total_success += 1;
                   } else {
                     item.failures += 1;
                     continuous_total_failure += 1;
                   }
                   update_continuous_row(ip);
                   continuous_log_line(QString(zh(u8"连续采集 第 %1 轮 %2，返回码 %3，错误 %4，完整帧 %5，深度 %6，亮度 %7，元数据 %8，尝试 %9，输出 %10，建议 %11"))
                                           .arg(continuous_round)
                                           .arg(ip)
                                           .arg(code)
                                           .arg(item.error_name)
                                           .arg(item.complete_frame ? zh(u8"是") : zh(u8"否"))
                                           .arg(item.depth_exists ? zh(u8"是") : zh(u8"否"))
                                           .arg(item.intensity_exists ? zh(u8"是") : zh(u8"否"))
                                           .arg(item.metadata_exists ? zh(u8"是") : zh(u8"否"))
                                           .arg(json.value("attempts").toInt(1))
                                           .arg(item.latest_output)
                                           .arg(json.value("operatorHint").toString("-")));
                   if (continuous_running) {
                     continuous_timer->start(continuous_interval_ms->value());
                   }
                 });
  };

  QObject::connect(continuous_timer, &QTimer::timeout, run_next_continuous_capture);

  auto begin_continuous_test = [&](QStringList ips) {
    if (ips.isEmpty()) {
      continuous_log_line(zh(u8"没有可测试的相机。"));
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
      continuous_stats[ip].error_name = "-";
      continuous_stats[ip].complete_frame = false;
      continuous_stats[ip].depth_exists = false;
      continuous_stats[ip].intensity_exists = false;
      continuous_stats[ip].metadata_exists = false;
      continuous_stats[ip].latest_output.clear();
      update_continuous_row(ip);
    }
    continuous_running = true;
    update_continuous_summary();
    QString output_dir = continuous_output_dir->text().trimmed();
    if (output_dir.isEmpty()) {
      output_dir = "continuous-test";
    }
    QJsonArray ip_array;
    for (const QString& ip : continuous_ips) {
      ip_array.append(ip);
    }
    QJsonObject body{
        {"expectedCameras", expected_camera_count->value()},
        {"rounds", continuous_rounds->value()},
        {"lines", lines->value()},
        {"width", width->value()},
        {"timeoutMs", timeout_ms->value()},
        {"intervalMs", continuous_interval_ms->value()},
        {"retries", continuous_retries->value()},
        {"controlMode", 0},
        {"dataMode", data_mode->currentData().toInt()},
        {"outputDir", output_dir},
        {"connectFirst", false},
        {"stopStreams", true},
        {"ips", ip_array},
    };
    continuous_log_line(QString(zh(u8"开始并行同步连续采集测试：%1 台相机，%2 轮。"))
                            .arg(continuous_ips.size())
                            .arg(continuous_rounds->value()));
    request_json(network, "POST", origin + "/api/capture/continuous-test", body, continuous_log,
                 [&](const QJsonObject& json) {
                   continuous_running = false;
                   continuous_timer->stop();
                   overview_last_summary = json;
                   overview_last_summary_path = json.value("summaryOutput").toString();
                   continuous_round = json.value("rounds").toInt(continuous_rounds->value());
                   continuous_total_attempts = 0;
                   continuous_total_success = 0;
                   continuous_total_failure = 0;

                   for (const QString& ip : continuous_ips) {
                     ContinuousStats& stats = continuous_stats[ip];
                     stats.attempts = 0;
                     stats.successes = 0;
                     stats.failures = 0;
                     stats.error_name = "-";
                     stats.complete_frame = false;
                     stats.depth_exists = false;
                     stats.intensity_exists = false;
                     stats.metadata_exists = false;
                     stats.latest_output.clear();
                   }

                   const QJsonArray results = json.value("results").toArray();
                   for (const QJsonValue& value : results) {
                     const QJsonObject result = value.toObject();
                     const QString ip = result.value("ip").toString();
                     if (ip.isEmpty()) {
                       continue;
                     }
                     ContinuousStats& item = continuous_stats[ip];
                     const int code = json_code(result);
                     item.attempts += 1;
                     item.last_code = code;
                     item.error_name = result.value("errorName").toString(code == 0 ? "CORRECT" : "-");
                     item.complete_frame = result.value("completeFrame").toBool(false);
                     item.depth_exists = result.value("depthExists").toBool(false);
                     item.intensity_exists = result.value("intensityExists").toBool(false);
                     item.metadata_exists = result.value("metadataExists").toBool(false);
                     item.latest_output = result.value("output").toString();
                     continuous_total_attempts += 1;
                     if (code == 0) {
                       item.successes += 1;
                       continuous_total_success += 1;
                     } else {
                       item.failures += 1;
                       continuous_total_failure += 1;
                     }
                     update_continuous_row(ip);
                     continuous_log_line(QString(zh(u8"并行采集 第 %1 轮 %2，返回码 %3，错误 %4，完整帧 %5，深度 %6，亮度 %7，元数据 %8，worker %9，尝试 %10，输出 %11，建议 %12"))
                                             .arg(result.value("round").toInt())
                                             .arg(ip)
                                             .arg(code)
                                             .arg(item.error_name)
                                             .arg(item.complete_frame ? zh(u8"是") : zh(u8"否"))
                                             .arg(item.depth_exists ? zh(u8"是") : zh(u8"否"))
                                             .arg(item.intensity_exists ? zh(u8"是") : zh(u8"否"))
                                             .arg(item.metadata_exists ? zh(u8"是") : zh(u8"否"))
                                             .arg(result.value("parallelIndex").toInt())
                                             .arg(result.value("attemptsUsed").toInt(1))
                                             .arg(item.latest_output)
                                             .arg(result.value("operatorHint").toString("-")));
                   }

                   continuous_total_attempts = json.value("attempts").toInt(continuous_total_attempts);
                   continuous_total_success = json.value("successes").toInt(continuous_total_success);
                   continuous_total_failure = json.value("failures").toInt(continuous_total_failure);
                   update_continuous_summary();
                   continuous_log_line(QString(zh(u8"并行同步连续采集完成：返回码 %1，成功 %2，失败 %3，完整帧 %4，worker %5，同步 %6，耗时 %7 ms，summary %8"))
                                           .arg(json_code(json))
                                           .arg(json.value("successes").toInt())
                                           .arg(json.value("failures").toInt())
                                           .arg(json.value("completeFrames").toInt())
                                           .arg(json.value("workerCount").toInt())
                                           .arg(json.value("syncMode").toString("-"))
                                           .arg(json.value("elapsedMs").toInt())
                                           .arg(overview_last_summary_path));
                   refresh_all();
                   render_overview();
                 });
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

  std::function<void()> start_continuous_capture_test = [&]() {
    if (continuous_running) {
      return;
    }
    auto start_after_stream_stopped = [&]() {
      prepare_continuous_test([&](QStringList ips) {
        begin_continuous_test(ips);
      });
    };
    if (!active_stream_ip.isEmpty()) {
      const QString stream_ip = active_stream_ip;
      request_json(network, "POST", origin + "/api/stream/stop", QJsonObject{{"ip", stream_ip}}, continuous_log,
                   [&, stream_ip, start_after_stream_stopped](const QJsonObject& json) {
                     continuous_log_line(QString(zh(u8"测试前停止预览 %1，返回码 %2")).arg(stream_ip).arg(json_code(json)));
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
  };

  auto sync_test_dialog_from_overview = [&]() {
    if (!overview_steel_state.value("steelId").toString().isEmpty()) {
      test_steel_id->setText(overview_steel_state.value("steelId").toString());
    }
    if (!overview_steel_state.value("steelType").toString().isEmpty()) {
      test_steel_type->setText(overview_steel_state.value("steelType").toString());
    }
    if (overview_steel_state.value("length").toDouble() > 0) {
      test_steel_length->setValue(overview_steel_state.value("length").toDouble());
    }
    if (overview_steel_state.value("width").toDouble() > 0) {
      test_steel_width->setValue(overview_steel_state.value("width").toDouble());
    }
    if (overview_steel_state.value("thickness").toDouble() > 0) {
      test_steel_thick->setValue(overview_steel_state.value("thickness").toDouble());
    }
  };

  QObject::connect(continuous_output_browse, &QPushButton::clicked, [&]() {
    const QString path = QFileDialog::getExistingDirectory(test_dialog, zh(u8"选择测试输出目录"), continuous_output_dir->text());
    if (!path.isEmpty()) {
      continuous_output_dir->setText(path);
    }
  });

  QObject::connect(test_close, &QPushButton::clicked, test_dialog, &QDialog::close);

  QObject::connect(test_button, &QPushButton::clicked, [&]() {
    sync_test_dialog_from_overview();
    test_dialog->show();
    test_dialog->raise();
    test_dialog->activateWindow();
  });

  QObject::connect(test_execute, &QPushButton::clicked, [&]() {
    const QString action = test_action->currentData().toString();
    if (action == "one-round") {
      run_one_round_capture_test();
      return;
    }
    if (action == "preset") {
      apply_line_preset_from_test();
      return;
    }
    if (action == "steel-out") {
      send_steel_presence_event(false, continuous_log);
      return;
    }
    if (action == "steel-in") {
      QJsonObject info{
          {"cmd", "rcvSteelInfo"},
          {"id", test_steel_id->text().trimmed()},
          {"steelType", test_steel_type->text().trimmed()},
          {"length", test_steel_length->value()},
          {"width", test_steel_width->value()},
          {"thick", test_steel_thick->value()},
      };
      request_json(network, "POST", origin + "/api/steel/event", info, continuous_log,
                   [&](const QJsonObject& info_json) {
                     overview_steel_state = info_json;
                     continuous_log_line(QString(zh(u8"钢板信息已写入：返回码 %1")).arg(json_code(info_json)));
                     send_steel_presence_event(true, continuous_log);
                   });
      return;
    }
    continuous_output_dir->setText(continuous_output_dir->text().trimmed().isEmpty() ? "continuous-test" : continuous_output_dir->text().trimmed());
    if (continuous_running) {
      continuous_log_line(zh(u8"已有采集测试正在运行。"));
      return;
    }
    start_continuous_capture_test();
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

  auto active_profile_for_calibration = [&]() {
    return overview_config_state.value("activeProfile").toString(profile_name->text().trimmed().isEmpty() ? "current-6-soft-trigger" : profile_name->text().trimmed());
  };

  auto storage_root_for_calibration = [&]() {
    QString root = overview_storage_state.value("root").toString();
    if (root.trimmed().isEmpty()) {
      root = overview_health_state.value("storageRoot").toString();
    }
    if (root.trimmed().isEmpty()) {
      root = storage_root->text().trimmed();
    }
    return root.trimmed().isEmpty() ? QString("E:/steel-capture-data") : root;
  };

  auto storage_relative_path = [&](const QString& path) {
    const QString absolute = provider_local_path(path);
    const QString root = storage_root_for_calibration();
    QDir root_dir(root);
    const QString relative = root_dir.relativeFilePath(absolute);
    if (!relative.startsWith("..")) {
      return QDir::fromNativeSeparators(relative);
    }
    return QDir::fromNativeSeparators(absolute);
  };

  auto copy_file_overwrite = [&](const QString& source, const QString& destination) {
    if (QFileInfo(source).absoluteFilePath() == QFileInfo(destination).absoluteFilePath()) {
      return true;
    }
    QDir().mkpath(QFileInfo(destination).absolutePath());
    if (QFile::exists(destination)) {
      QFile::remove(destination);
    }
    return QFile::copy(source, destination);
  };

  auto ensure_fit_in_version_library = [&]() {
    if (calibration_fit_report.isEmpty() || calibration_corrected_xml_path.trimmed().isEmpty()) {
      log_line(calibration_log, zh(u8"请先导入或生成 fit_report。"));
      return false;
    }
    const QString profile = active_profile_for_calibration();
    QString version = QFileInfo(calibration_version_dir).fileName();
    if (version.trimmed().isEmpty()) {
      version = "array-calibration-fit-" + QDateTime::currentDateTime().toString("yyyyMMdd-HHmmss");
    }
    const QString dest_dir = QDir(storage_root_for_calibration()).filePath("config/calibrations/" + profile + "/" + version);
    const QString dest_xml = QDir(dest_dir).filePath("ArrayCalibration.corrected.xml");
    const QString dest_report = QDir(dest_dir).filePath("fit_report.json");
    const QString dest_before = QDir(dest_dir).filePath("cross_section_before.png");
    const QString dest_after = QDir(dest_dir).filePath("cross_section_corrected.png");
    const QString dest_csv = QDir(dest_dir).filePath("camera_corrections.csv");
    const QString dest_points = QDir(dest_dir).filePath("cross_section_points.csv");
    if (!copy_file_overwrite(provider_local_path(calibration_corrected_xml_path), dest_xml) ||
        !copy_file_overwrite(provider_local_path(calibration_fit_report_file), dest_report) ||
        !copy_file_overwrite(provider_local_path(calibration_before_preview_path), dest_before) ||
        !copy_file_overwrite(provider_local_path(calibration_after_preview_path), dest_after)) {
      log_line(calibration_log, zh(u8"复制标定版本文件失败。"));
      return false;
    }
    const QString source_csv = QDir(calibration_version_dir).filePath("camera_corrections.csv");
    if (QFile::exists(source_csv)) {
      copy_file_overwrite(source_csv, dest_csv);
    }
    QString source_points = calibration_fit_report.value("pointsCsv").toString();
    if (source_points.trimmed().isEmpty()) {
      source_points = QDir(calibration_version_dir).filePath("cross_section_points.csv");
    }
    if (QFile::exists(provider_local_path(source_points))) {
      copy_file_overwrite(provider_local_path(source_points), dest_points);
    }
    calibration_version_dir = QFileInfo(dest_xml).absolutePath();
    calibration_corrected_xml_path = dest_xml;
    calibration_fit_report_file = dest_report;
    calibration_before_preview_path = dest_before;
    calibration_after_preview_path = dest_after;
    add_version_row(version, zh(u8"版本库"), calibration_corrected_residual->text(), dest_dir);
    return true;
  };

  auto active_calibration_body = [&](bool save_to_device) {
    return QJsonObject{
        {"name", active_profile_for_calibration()},
        {"path", storage_relative_path(calibration_corrected_xml_path)},
        {"version", QFileInfo(calibration_version_dir).fileName()},
        {"fitReport", storage_relative_path(calibration_fit_report_file)},
        {"beforePreview", storage_relative_path(calibration_before_preview_path)},
        {"afterPreview", storage_relative_path(calibration_after_preview_path)},
        {"sourceCalibration", calibration_fit_report.value("calibration").toString()},
        {"fitBefore", calibration_fit_report.value("fitBefore").toObject()},
        {"fitAfter", calibration_fit_report.value("fitAfter").toObject()},
        {"cameraParamDir", "config/camera-params/" + active_profile_for_calibration()},
        {"saveToDevice", save_to_device},
        {"appliedBy", "qt-auto-calibration"},
    };
  };

  QObject::connect(calibration_import_fit, &QPushButton::clicked, [&]() {
    QString path = calibration_fit_report_path->text().trimmed();
    if (path.isEmpty()) {
      path = QFileDialog::getOpenFileName(&window,
                                          zh(u8"选择拟合报告"),
                                          storage_root_for_calibration(),
                                          "fit_report.json (fit_report.json);;JSON (*.json);;All Files (*.*)");
    }
    if (!path.isEmpty()) {
      load_fit_report_file(path);
    }
  });

  QObject::connect(calibration_refresh_active, &QPushButton::clicked, refresh_active_calibration);

  QObject::connect(calibration_open_version, &QPushButton::clicked, [&]() {
    const QString dir = calibration_version_dir.trimmed().isEmpty() ? storage_root_for_calibration() : calibration_version_dir;
    QDesktopServices::openUrl(QUrl::fromLocalFile(provider_local_path(dir)));
  });

  QObject::connect(calibration_set_current, &QPushButton::clicked, [&]() {
    if (!ensure_fit_in_version_library()) {
      return;
    }
    request_json(network,
                 "POST",
                 origin + "/api/calibration/active",
                 active_calibration_body(false),
                 calibration_log,
                 [&](const QJsonObject& json) {
                   calibration_active_state = json;
                   calibration_log->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"当前阵列标定已更新，返回码 %1")).arg(json_code(json)));
                   refresh_config_status();
                 });
  });

  QObject::connect(calibration_apply_all, &QPushButton::clicked, [&]() {
    if (!ensure_fit_in_version_library()) {
      return;
    }
    QStringList camera_lines;
    for (const auto& item : overview_status_by_ip) {
      camera_lines << QString("%1  %2  %3")
                          .arg(item.first)
                          .arg(item.second.value("model").toString())
                          .arg(item.second.value("sn").toString());
    }
    const QString confirm = QString(zh(u8"将覆盖应用当前阵列标定并写回相机参数。\n\n目标 XML：%1\n\n相机：\n%2\n\n动作：逐台尝试 SDK 标定加载，保存 .nccfg，并 saveToDevice=true。"))
                                .arg(calibration_corrected_xml_path)
                                .arg(camera_lines.join("\n"));
    if (QMessageBox::warning(&window,
                             zh(u8"确认覆盖应用标定"),
                             confirm,
                             QMessageBox::Yes | QMessageBox::No,
                             QMessageBox::No) != QMessageBox::Yes) {
      log_line(calibration_log, zh(u8"已取消覆盖应用标定。"));
      return;
    }
    QJsonObject body = active_calibration_body(true);
    body.insert("persistActive", true);
    body.insert("saveCameraParams", true);
    body.insert("saveToDevice", true);
    body.insert("applySoftTrigger", false);
    body.insert("stopStreams", true);
    request_json(network,
                 "POST",
                 origin + "/api/calibration/apply-all",
                 body,
                 calibration_log,
                 [&](const QJsonObject& json) {
                   calibration_log->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"全局标定应用完成：返回码 %1，应用 %2，失败 %3"))
                                     .arg(json_code(json))
                                     .arg(json.value("applied").toInt())
                                     .arg(json.value("failed").toInt()));
                   refresh_active_calibration();
                   refresh_statuses();
                 });
  });

  QObject::connect(calibration_save_params, &QPushButton::clicked, [&]() {
    const QString profile = active_profile_for_calibration();
    QJsonArray ips;
    for (const auto& item : overview_status_by_ip) {
      ips.append(item.first);
    }
    request_json(network,
                 "POST",
                 origin + "/api/config/camera-params/save-all",
                 QJsonObject{
                     {"name", profile},
                     {"cameraParamDir", "config/camera-params/" + profile},
                     {"ips", ips},
                     {"applySoftTrigger", false},
                     {"saveToDevice", true},
                 },
                 calibration_log,
                 [&](const QJsonObject& json) {
                   calibration_log->setPlainText(json_to_text(json));
                   log_line(log, QString(zh(u8"保存相机参数完成：返回码 %1，成功 %2，失败 %3"))
                                     .arg(json_code(json))
                                     .arg(json.value("saved").toInt())
                                     .arg(json.value("failed").toInt()));
                 });
  });

  QObject::connect(calibration_auto_fit, &QPushButton::clicked, [&]() {
    const QString profile = active_profile_for_calibration();
    const QString output_dir = "continuous-test/auto-calibration-" + QDateTime::currentDateTime().toString("yyyyMMdd-HHmmss");
    QJsonObject capture_body{
        {"expectedCameras", expected_camera_count->value()},
        {"rounds", 1},
        {"lines", lines->value()},
        {"width", width->value()},
        {"timeoutMs", timeout_ms->value()},
        {"intervalMs", 500},
        {"retries", 0},
        {"controlMode", 0},
        {"dataMode", data_mode->currentData().toInt()},
        {"outputDir", output_dir},
        {"connectFirst", true},
        {"stopStreams", true},
    };
    log_line(calibration_log, zh(u8"开始自动标定采集一轮。"));
    request_json(network,
                 "POST",
                 origin + "/api/capture/continuous-test",
                 capture_body,
                 calibration_log,
                 [&, profile](const QJsonObject& capture_json) {
                   calibration_log->setPlainText(json_to_text(capture_json));
                   if (json_code(capture_json) != 0 || capture_json.value("successes").toInt() < expected_camera_count->value()) {
                     log_line(calibration_log, zh(u8"自动标定采集未全部成功，停止拟合。"));
                     return;
                   }
                   const QString summary = provider_local_path(capture_json.value("summaryOutput").toString());
                   const QString data_dir = QFileInfo(summary).absolutePath();
                   QString calibration_path_for_fit = calibration_active_state.value("calibrationPath").toString();
                   if (calibration_path_for_fit.trimmed().isEmpty()) {
                     calibration_path_for_fit = provider_local_path("config/camera-params/" + profile + "/ArrayCalibration.xml");
                   }
                   const QString output_root = QDir(storage_root_for_calibration()).filePath("config/calibrations/" + profile);
                   QString script = QDir::current().filePath("scripts/fit_array_calibration_cross_section.py");
                   if (!QFile::exists(script)) {
                     script = QDir(QApplication::applicationDirPath()).filePath("scripts/fit_array_calibration_cross_section.py");
                   }
                   if (!QFile::exists(script)) {
                     script = QDir(QApplication::applicationDirPath()).filePath("../scripts/fit_array_calibration_cross_section.py");
                   }
                   if (!QFile::exists(script)) {
                     log_line(calibration_log, zh(u8"找不到自动拟合脚本。"));
                     return;
                   }
                   QDir().mkpath(output_root);
                   auto* process = new QProcess(&window);
                   process->setProgram("python");
                   process->setArguments({
                       script,
                       "--calibration",
                       provider_local_path(calibration_path_for_fit),
                       "--data-dir",
                       data_dir,
                       "--rows",
                       "250,500,750",
                       "--output-root",
                       output_root,
                       "--max-shift-mm",
                       "3",
                   });
                   QObject::connect(process, &QProcess::readyReadStandardError, [&, process]() {
                     log_line(calibration_log, QString::fromUtf8(process->readAllStandardError()).trimmed());
                   });
                   QObject::connect(process, QOverload<int, QProcess::ExitStatus>::of(&QProcess::finished),
                                    [&, process](int exit_code, QProcess::ExitStatus status) {
                                      const QByteArray output = process->readAllStandardOutput();
                                      process->deleteLater();
                                      if (status != QProcess::NormalExit || exit_code != 0) {
                                        log_line(calibration_log, QString(zh(u8"自动拟合失败，退出码 %1")).arg(exit_code));
                                        return;
                                      }
                                      const QJsonDocument doc = QJsonDocument::fromJson(output);
                                      if (!doc.isObject()) {
                                        log_line(calibration_log, zh(u8"自动拟合输出不是 JSON。"));
                                        return;
                                      }
                                      const QString report_path = QDir(doc.object().value("outputDir").toString()).filePath("fit_report.json");
                                      load_fit_report_file(report_path);
                                      log_line(calibration_log, zh(u8"自动拟合完成，请检查修正预览后再覆盖应用。"));
                                    });
                   log_line(calibration_log, zh(u8"开始自动拟合脚本。"));
                   process->start();
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
  QTimer::singleShot(1400, auto_apply_startup_profile);
  QObject::connect(poll_timer, &QTimer::timeout, refresh_all);
  poll_timer->start(3000);

  log_line(log, zh(u8"Qt 采集端已启动，所有相机默认使用软触发。"));
  window.show();
  return app.exec();
}

